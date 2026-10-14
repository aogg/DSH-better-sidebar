/**
 * The paste engine (src/fs-transfer.ts): the file tree's 复制/剪切黏贴 lands
 * through ONE async host job — pre-walked totals, streamed copy progress,
 * Windows replace/skip semantics, merge moves, cancel. These cases drive the
 * REAL filesystem through a `mkdtemp` workspace (never the user's temp), and
 * settle every job by polling `transferStatus` the way the wire route does.
 */
import { lstat, mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startWorkspaceTransfer, transferCancel, transferStatus, type TransferStatusView } from '../src/fs-transfer.ts'

let workspace: string

/** lstat wrapper (keeps the test bodies tidy). */
async function lstatOf(path: string): Promise<Awaited<ReturnType<typeof lstat>>> {
  return lstat(path)
}

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'dsh-sidebar-transfer-'))
})

afterEach(async () => {
  await rm(workspace, { force: true, recursive: true })
})

/** Poll a job to a terminal state (the client's fs.transferStatus loop). */
async function settle(transferId: string): Promise<TransferStatusView> {
  for (;;) {
    const status = transferStatus(transferId)
    if (status === undefined) throw new Error(`transfer vanished: ${transferId}`)
    if (status.state === 'done' || status.state === 'error' || status.state === 'canceled') return status
    await new Promise(resolve => { setTimeout(resolve, 5) })
  }
}

describe('fs.transfer：复制', () => {
  it('复制一个文件：内容一致，进度记一笔', async () => {
    const src = join(workspace, 'a.txt')
    await writeFile(src, 'hello paste')
    const target = join(workspace, 'dest')
    await mkdir(target)
    const accepted = await startWorkspaceTransfer({ cwd: workspace, mode: 'copy', items: [src], targetDir: target, conflict: 'skip' })
    expect(accepted.totalFiles).toBe(1)
    const status = await settle(accepted.transferId)
    expect(status.state).toBe('done')
    expect(await readFile(join(target, 'a.txt'), 'utf8')).toBe('hello paste')
    // The source stays (it is a COPY).
    expect(await readFile(src, 'utf8')).toBe('hello paste')
  })

  it('复制一棵目录树：嵌套目录、空目录与符号链接都跟着走', async () => {
    const src = join(workspace, 'tree')
    await mkdir(join(src, 'deep'), { recursive: true })
    await writeFile(join(src, 'deep', 'f.txt'), 'nested')
    await mkdir(join(src, 'empty'))
    await symlink('deep/f.txt', join(src, 'link'))
    const target = join(workspace, 'dest')
    await mkdir(target)
    const accepted = await startWorkspaceTransfer({ cwd: workspace, mode: 'copy', items: [src], targetDir: target, conflict: 'skip' })
    expect(accepted.totalFiles).toBe(2) // f.txt + the symlink; the dirs are shells
    const status = await settle(accepted.transferId)
    expect(status.state).toBe('done')
    expect(await readFile(join(target, 'tree', 'deep', 'f.txt'), 'utf8')).toBe('nested')
    expect(readdir(join(target, 'tree', 'empty'))).resolves.toEqual([])
    const link = await lstatOf(join(target, 'tree', 'link'))
    expect(link.isSymbolicLink()).toBe(true)
  })

  it('黏进自己或自己的子目录：条目被丢弃，全部 self 时整单拒绝', async () => {
    const src = join(workspace, 'tree')
    await mkdir(join(src, 'sub'), { recursive: true })
    // tree → tree/sub folds into itself: dropped, batch empty → refused.
    await expect(startWorkspaceTransfer({
      cwd: workspace, mode: 'copy', items: [src], targetDir: join(src, 'sub'), conflict: 'skip',
    })).rejects.toThrow(/nothing to transfer/)
  })
})

describe('fs.transfer：冲突语义', () => {
  it('skip：同名文件原样保留，进度照常完成', async () => {
    const src = join(workspace, 'a.txt')
    await writeFile(src, 'new')
    const target = join(workspace, 'dest')
    await mkdir(target)
    await writeFile(join(target, 'a.txt'), 'old')
    const accepted = await startWorkspaceTransfer({ cwd: workspace, mode: 'copy', items: [src], targetDir: target, conflict: 'skip' })
    const status = await settle(accepted.transferId)
    expect(status.state).toBe('done')
    expect(await readFile(join(target, 'a.txt'), 'utf8')).toBe('old')
  })

  it('replace（文件对文件）：覆盖', async () => {
    const src = join(workspace, 'a.txt')
    await writeFile(src, 'new')
    const target = join(workspace, 'dest')
    await mkdir(target)
    await writeFile(join(target, 'a.txt'), 'old')
    const accepted = await startWorkspaceTransfer({ cwd: workspace, mode: 'copy', items: [src], targetDir: target, conflict: 'replace' })
    const status = await settle(accepted.transferId)
    expect(status.state).toBe('done')
    expect(await readFile(join(target, 'a.txt'), 'utf8')).toBe('new')
  })

  it('replace（目录对目录）：合并——已有文件被覆盖，新文件加入，源目录消失（move）', async () => {
    const src = join(workspace, 'tree')
    await mkdir(src)
    await writeFile(join(src, 'a.txt'), 'from-src')
    await writeFile(join(src, 'b.txt'), 'only-src')
    const target = join(workspace, 'dest')
    await mkdir(join(target, 'tree'), { recursive: true })
    await writeFile(join(target, 'tree', 'a.txt'), 'old-dest')
    const accepted = await startWorkspaceTransfer({ cwd: workspace, mode: 'move', items: [src], targetDir: target, conflict: 'replace' })
    const status = await settle(accepted.transferId)
    expect(status.state).toBe('done')
    expect(await readFile(join(target, 'tree', 'a.txt'), 'utf8')).toBe('from-src')
    expect(await readFile(join(target, 'tree', 'b.txt'), 'utf8')).toBe('only-src')
    // The move emptied and removed the source.
    await expect(readdir(src)).rejects.toThrow()
  })

  it('replace（文件对目录）：该条目失败但批继续，itemErrors 记录原因', async () => {
    const fileSrc = join(workspace, 'f.txt')
    await writeFile(fileSrc, 'data')
    const dirSrc = join(workspace, 'd')
    await mkdir(dirSrc)
    await writeFile(join(dirSrc, 'x.txt'), 'x')
    const target = join(workspace, 'dest')
    await mkdir(target)
    await mkdir(join(target, 'f.txt'))
    const accepted = await startWorkspaceTransfer({
      cwd: workspace, mode: 'copy', items: [fileSrc, dirSrc], targetDir: target, conflict: 'replace',
    })
    expect(accepted.totalFiles).toBe(2)
    const status = await settle(accepted.transferId)
    expect(status.state).toBe('done')
    expect(status.itemErrors).toHaveLength(1)
    expect(status.itemErrors[0]).toContain('f.txt')
    // The directory item still went through.
    expect(await readFile(join(target, 'd', 'x.txt'), 'utf8')).toBe('x')
  })
})

describe('fs.transfer：移动与取消', () => {
  it('move：文件搬家，源消失，bytes 记账完整', async () => {
    const src = join(workspace, 'a.txt')
    await writeFile(src, 'moving')
    const target = join(workspace, 'dest')
    await mkdir(target)
    const accepted = await startWorkspaceTransfer({ cwd: workspace, mode: 'move', items: [src], targetDir: target, conflict: 'skip' })
    const status = await settle(accepted.transferId)
    expect(status.state).toBe('done')
    expect(status.bytesDone).toBe(status.totalBytes)
    expect(await readFile(join(target, 'a.txt'), 'utf8')).toBe('moving')
    await expect(readFile(src, 'utf8')).rejects.toThrow()
  })

  it('cancel：受理后立即取消 → 终态 canceled（部分文件可能已就位）', async () => {
    const src = join(workspace, 'many')
    await mkdir(src)
    for (let at = 0; at < 200; at += 1) {
      await writeFile(join(src, `f${at}.txt`), `content-${at}`)
    }
    const target = join(workspace, 'dest')
    await mkdir(target)
    const accepted = await startWorkspaceTransfer({ cwd: workspace, mode: 'copy', items: [src], targetDir: target, conflict: 'skip' })
    expect(transferCancel(accepted.transferId)).toBe(true)
    const status = await settle(accepted.transferId)
    expect(status.state).toBe('canceled')
  })

  it('cancel：未知 id 返回 false；完结任务仍返回 true 但不再改变终态', async () => {
    expect(transferCancel('nope')).toBe(false)
    const src = join(workspace, 'a.txt')
    await writeFile(src, 'x')
    const target = join(workspace, 'dest')
    await mkdir(target)
    const accepted = await startWorkspaceTransfer({ cwd: workspace, mode: 'copy', items: [src], targetDir: target, conflict: 'skip' })
    await settle(accepted.transferId)
    expect(transferCancel(accepted.transferId)).toBe(true)
    expect(transferStatus(accepted.transferId)?.state).toBe('done')
  })
})

describe('fs.transfer：入口拒绝', () => {
  it('mode/conflict 非法、items 为空、目标不是目录 → 请求级拒绝', async () => {
    const target = join(workspace, 'dest')
    await mkdir(target)
    await expect(startWorkspaceTransfer({
      cwd: workspace, mode: 'clone' as 'copy', items: [join(workspace, 'a.txt')], targetDir: target, conflict: 'skip',
    })).rejects.toThrow(/mode must be/)
    await expect(startWorkspaceTransfer({
      cwd: workspace, mode: 'copy', items: [], targetDir: target, conflict: 'skip',
    })).rejects.toThrow(/non-empty/)
    const fileTarget = join(workspace, 'a.txt')
    await writeFile(fileTarget, 'x')
    await expect(startWorkspaceTransfer({
      cwd: workspace, mode: 'copy', items: [fileTarget], targetDir: fileTarget, conflict: 'skip',
    })).rejects.toThrow(/not a directory/)
  })
})
