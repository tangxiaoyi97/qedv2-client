import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const workflowUrl = new URL('../../../.github/workflows/desktop-release.yml', import.meta.url)
const ciWorkflowUrl = new URL('../../../.github/workflows/desktop-ci.yml', import.meta.url)

function namedStep(workflow, name) {
  const marker = `      - name: ${name}`
  const start = workflow.indexOf(marker)
  if (start < 0) throw new Error(`Missing workflow step: ${name}`)
  const next = workflow.indexOf('\n      - ', start + marker.length)
  return workflow.slice(start, next < 0 ? undefined : next)
}

function expectBashFailFast(workflow, name) {
  const step = namedStep(workflow, name)
  expect(step).toContain('\n        shell: bash')
  expect(step).toContain('\n        run: |\n          set -euo pipefail')
}

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
    expect(publishWorkflow).toContain('The publish job did not receive the canonical 18-file release set.')
    expect(publishWorkflow).toContain('The verified draft asset identities changed before publication.')
    expect(publishWorkflow).toContain('gh api "repos/$GITHUB_REPOSITORY/releases/latest"')
    expect(publishWorkflow).not.toContain('releases/tags/$RELEASE_TAG')
  })

  it('fails fast for every multi-command Windows verification step', async () => {
    const ciWorkflow = await readFile(ciWorkflowUrl, 'utf8')
    expectBashFailFast(ciWorkflow, 'Verify complete client workspace')
    expectBashFailFast(ciWorkflow, 'Verify bundled Core')

    const releaseWorkflow = await readFile(workflowUrl, 'utf8')
    const windowsJob = releaseWorkflow.slice(
      releaseWorkflow.indexOf('\n  windows:'),
      releaseWorkflow.indexOf('\n  linux:'),
    )
    expectBashFailFast(windowsJob, 'Install dependencies')
    expectBashFailFast(windowsJob, 'Prepare runtime and build')
  })
})
