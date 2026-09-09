import { NextResponse } from "next/server";
import { getSessionUser, DEV_PERSONAS, findPersonaById, DEFAULT_USER } from "@/lib/server/auth";

export async function GET(request: Request) {
  const user = await getSessionUser(request);
  return NextResponse.json({
    user,
    availableUsers: DEV_PERSONAS,
  });
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { userId?: string };
    const targetId = body.userId;
    const user = (targetId && findPersonaById(targetId)) || DEFAULT_USER;

    const response = NextResponse.json({
      user,
      availableUsers: DEV_PERSONAS,
    });

    response.cookies.set("echo_user_id", user.id, {
      path: "/",
      sameSite: "lax",
      httpOnly: false,
      maxAge: 86400 * 30,
    });

    return response;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
}

