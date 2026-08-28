const prettyJson = (value: string): string => JSON.stringify(JSON.parse(value) as unknown, null, 2)

export const formatJsonText = (value?: string): string | undefined => {
  const text = value?.trim()
  if (!text) return undefined

  try {
    return prettyJson(text)
  } catch {
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    if (lines.length < 2) return undefined
    try {
      return lines.map(prettyJson).join('\n\n')
    } catch {
      return undefined
    }
  }
}
