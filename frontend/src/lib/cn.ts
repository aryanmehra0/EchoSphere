/**
 * Minimal class-name joiner.
 *
 * Deliberately not `clsx` + `tailwind-merge`: this console has a fixed set of
 * variants defined in one place each, so there are no conflicting utilities to
 * resolve at runtime. Two dependencies and a 6KB merge pass would buy nothing.
 */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
