"""
Enterprise Project Workspaces Router — REST endpoints for the project modal.

List/read project workspaces, save and probe observability connectors, and
spin up an incident (war room) record against a project. This is the
workspace layer ABOVE the single-incident Ledger — see
`app.domain.services.projects` for why it is a separate in-memory registry.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.domain.services.projects import ProjectNotFoundError, projects_service

log = logging.getLogger("echo.projects")

router = APIRouter(prefix="/projects", tags=["projects"])


class SaveConnectorRequest(BaseModel):
    provider: str
    name: str | None = None
    endpoint: str | None = None
    secret: str | None = None
    apiKey: str | None = None
    authHeader: str | None = None
    region: str | None = None
    serviceFilter: str | None = None


class TestConnectorRequest(BaseModel):
    provider: str
    endpoint: str | None = None
    secret: str | None = None
    region: str | None = None
    serviceFilter: str | None = None


class CreateIncidentRequest(BaseModel):
    title: str
    severity: int = Field(1, ge=1, le=3)
    channel: str


@router.get("")
async def list_projects() -> dict[str, Any]:
    return {"projects": projects_service.list_projects()}


@router.get("/{project_id}")
async def get_project(project_id: str) -> dict[str, Any]:
    project = projects_service.get_project(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail=f"Unknown project: {project_id}")
    return {"project": project}


@router.post("/{project_id}/connectors")
async def save_connector(project_id: str, body: SaveConnectorRequest) -> dict[str, Any]:
    try:
        connector = projects_service.save_connector(project_id, body.model_dump(exclude_none=True))
    except ProjectNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"Unknown project: {exc}") from exc
    return {"connector": connector}


@router.post("/{project_id}/connectors/test")
async def test_connector(project_id: str, body: TestConnectorRequest) -> dict[str, Any]:
    try:
        return await projects_service.test_connector(project_id, body.model_dump(exclude_none=True))
    except ProjectNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"Unknown project: {exc}") from exc


@router.post("/{project_id}/incidents")
async def create_incident(project_id: str, body: CreateIncidentRequest) -> dict[str, Any]:
    try:
        incident = projects_service.create_incident(project_id, body.model_dump())
    except ProjectNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"Unknown project: {exc}") from exc
    log.info("project %s: war room created — %s (%s)", project_id, incident["title"], incident["channel"])
    return {"incident": incident}
