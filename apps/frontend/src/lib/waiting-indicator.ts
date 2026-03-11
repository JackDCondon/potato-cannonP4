type MessageLike = {
  type?: string
}

export function isAwaitingUserInput(messages: MessageLike[]): boolean {
  if (!messages.length) return false
  const lastMessage = messages[messages.length - 1]
  return lastMessage?.type === 'question'
}

export function getWaitingIndicatorLabel(
  activity: string | null | undefined,
  awaitingUserInput: boolean
): string {
  if (activity) return activity
  return awaitingUserInput ? 'Waiting for your response' : 'Thinking'
}
