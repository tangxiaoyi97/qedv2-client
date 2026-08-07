import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const workflowUrl = new URL('../../../.github/workflows/desktop-release.yml', import.meta.url)

describe('desktop release workflow', () => {
  it('uses explicit REST endpoints for the checkout-free draft lifecycle', async () => {
    const workflow = (await readFile(workflowUrl, 'utf8')).replace(/\\\r?\n\s*/gu, ' ')
    const publishWorkflow = workflow.slice(workflow.indexOf('name: Publish verified GitHub Release'))

    expect(publishWorkflow).not.toMatch(/\bgh release\b/u)
    expect(publishWorkflow).toContain('gh api --method POST "repos/$GITHUB_REPOSITORY/releases"')
    expect(publishWorkflow).toContain('--raw-field target_commitish="$CLIENT_SHA"')
    expect(publishWorkflow).toContain('gh api --paginate --slurp "repos/$GITHUB_REPOSITORY/releases?per_page=100"')
    expect(publishWorkflow).toContain('https://uploads.github.com/repos/$GITHUB_REPOSITORY/releases/$RELEASE_ID/assets?name=$ENCODED_ASSET_NAME')
    expect(publishWorkflow).toContain("--header 'Accept: application/octet-stream'")
    expect(publishWorkflow).toContain('gh api --method PATCH "$RELEASE_API"')
    expect(publishWorkflow).not.toContain('releases/tags/$RELEASE_TAG')
  })
})
