/** `--until` / `--grep` pattern: `/re/flags` compiles to a regex, anything else is a substring. */
export function buildMatcher(pattern: string): (text: string) => boolean {
  const regexMatch = /^\/(.+)\/([gimsuy]*)$/.exec(pattern)
  if (regexMatch) {
    const re = new RegExp(regexMatch[1], regexMatch[2])
    return (text) => re.test(text)
  }
  return (text) => text.includes(pattern)
}
