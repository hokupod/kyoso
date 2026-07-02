import { KYOSO_CHILD_AGENT } from "../core/constants.js";
import { KyosoRequestError } from "../core/errors.js";

export function assertNotChildAgent(env: NodeJS.ProcessEnv = process.env): void {
  if (env[KYOSO_CHILD_AGENT] === "1") {
    throw new KyosoRequestError("Kyoso recursion guard blocked child-agent invocation.", "RECURSION_GUARD");
  }
}
