export function nextCollapsedTopic(
  collapsedTopic: string | null,
  topicId: string,
  isActive: boolean,
  pageCount: number,
): string | null {
  if (!isActive || pageCount <= 1) return null;
  return collapsedTopic === topicId ? null : topicId;
}
