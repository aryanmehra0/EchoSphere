"""
Tests for Ports and Protocols (Hexagonal Boundary).

Validates that concrete adapters and domain classes satisfy the defined Inbound
and Outbound Port protocols.
"""

from __future__ import annotations

import unittest

from app.adapters.agora_bridge import BridgeController
from app.deltas import DeltaHub
from app.extraction import extract
from app.ledger import EvidenceLedger
from app.panel import DeliberationPanel
from app.ports.inbound import (
    ActionApprovalUseCase,
    ContradictionAdjudicationUseCase,
    PrivacyConsentUseCase,
    QueryIncidentStateUseCase,
)
from app.ports.outbound import (
    ContradictionPanelPort,
    DeltaBroadcasterPort,
    ExtractionLlmPort,
    LedgerStorePort,
    VoiceBridgePort,
)
from app.privacy import PrivacyGate
from app.proxy import ProxyActionLayer


class TestPortProtocols(unittest.TestCase):
    def test_privacy_gate_satisfies_privacy_consent_use_case(self) -> None:
        gate = PrivacyGate()
        self.assertIsInstance(gate, PrivacyConsentUseCase)

    def test_proxy_action_layer_satisfies_action_approval_use_case(self) -> None:
        proxy = ProxyActionLayer("test-chan")
        self.assertIsInstance(proxy, ActionApprovalUseCase)

    def test_evidence_ledger_satisfies_query_incident_state_use_case(self) -> None:
        ledger = EvidenceLedger("test-chan")
        self.assertIsInstance(ledger, QueryIncidentStateUseCase)

    def test_deliberation_panel_satisfies_contradiction_ports(self) -> None:
        panel = DeliberationPanel()
        self.assertIsInstance(panel, ContradictionPanelPort)
        self.assertIsInstance(panel, ContradictionAdjudicationUseCase)

    def test_delta_hub_satisfies_delta_broadcaster_port(self) -> None:
        hub = DeltaHub()
        self.assertIsInstance(hub, DeltaBroadcasterPort)

    def test_bridge_controller_satisfies_voice_bridge_port(self) -> None:
        bridge = BridgeController("channel", "agent-123")
        self.assertIsInstance(bridge, VoiceBridgePort)

    def test_extract_function_satisfies_extraction_llm_port(self) -> None:
        self.assertIsInstance(extract, ExtractionLlmPort)

    def test_store_module_satisfies_ledger_store_port(self) -> None:
        from app import store

        self.assertIsInstance(store, LedgerStorePort)


if __name__ == "__main__":
    unittest.main()

