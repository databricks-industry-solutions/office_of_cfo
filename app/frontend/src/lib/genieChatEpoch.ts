/**
 * Epoch for the open Genie chat. Each send captures the current value; New chat
 * bumps it so any in-flight reply whose tag no longer matches is ignored —
 * otherwise a late answer re-fills the cleared transcript and re-attaches the
 * old conversation id.
 */
export function bumpGenieChatEpoch(epoch: number): number {
  return epoch + 1;
}

export function isCurrentGenieChatEpoch(sendEpoch: number, currentEpoch: number): boolean {
  return sendEpoch === currentEpoch;
}
