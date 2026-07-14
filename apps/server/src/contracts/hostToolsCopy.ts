/**
 * The host-tools security copy. **Zod-free on purpose.**
 *
 * The web app imports this directly, and the web bundle carries no zod -- importing it
 * from `contracts.ts` (which does) pulled the whole validator into the browser. The same
 * rule `attachments.ts` follows, and for the same reason.
 *
 * The copy is shared, and served, because a security warning each client writes for
 * itself is the one copy you least want drifting.
 */

/**
 * Host tools are **unsandboxed**: they run with the same OS permissions as the user who
 * launched Nelle. That is not a preference, it is a decision -- which is why enabling them
 * is gated on an acknowledgement the server *enforces* (`enabled` without `acknowledged`
 * is refused) rather than merely rendered.
 */
export const HOST_TOOLS_WARNING =
  'Host file and shell tools run with the same OS permissions as the user who launched ' +
  'Nelle. They are not sandboxed. Anything the model decides to run, runs.';

export const HOST_TOOLS_DESCRIPTION =
  'Lets the model read and edit files, search the project, and run shell commands from a ' +
  'conversation.';
