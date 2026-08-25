import { IncidentConsole } from "@/components/IncidentConsole";

/**
 * The console is a single full-viewport surface, so the route does nothing but
 * mount it. Keeping this a server component means the page shell streams
 * immediately and only the interactive console pays for hydration.
 */
export default function Page() {
  return <IncidentConsole />;
}
