import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const workflowUrl = new URL('../../../.github/workflows/desktop-release.yml', import.meta.url)

describe('desktop release workflow', () => {
  it('selects the repository explicitly for every checkout-free release command', async () => {
    const workflow = (await readFile(workflowUrl, 'utf8')).replace(/\\\r?\n\s*/gu, ' ')
    const publishWorkflow = workflow.slice(workflow.indexOf('name: Publish verified GitHub Release'))
    const releaseCommands = publishWorkflow
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => /^gh release (?:upload|download|edit)\b/u.test(line))

    expect(releaseCommands.map((command) => (
      command.match(/^gh release (upload|download|edit)\b/u)?.[1]
    )).sort()).toEqual(['download', 'edit', 'upload'])
    for (const command of releaseCommands) {
      expect(command).toContain('--repo "$GITHUB_REPOSITORY"')
    }
    expect(publishWorkflow).toContain('gh api --method POST "repos/$GITHUB_REPOSITORY/releases"')
    expect(publishWorkflow).toContain('gh api --paginate --slurp "repos/$GITHUB_REPOSITORY/releases?per_page=100"')
    expect(publishWorkflow).not.toContain('releases/tags/$RELEASE_TAG')
  })
})
