/*
 * Triptych's runtime readiness gate. Static host readiness deliberately stays generic and cheap:
 * it proves the runner and declared packages resolve. Before the runner dials Accordion, this gate
 * proves the defining tree-sitter engine can actually initialize every grammar. A corrupt or
 * incompatible install therefore exits before Triptych can attach as a summaries-only conductor.
 */

export async function initializeSkeletonizer(skeletonizer) {
  if (!skeletonizer || typeof skeletonizer.init !== "function" || typeof skeletonizer.ready !== "function") {
    throw new Error("skeleton engine does not implement init()/ready()");
  }

  await skeletonizer.init();
  if (!skeletonizer.ready()) throw new Error("skeleton engine initialization completed without becoming ready");
}
