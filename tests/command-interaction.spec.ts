/**
 * 「命令」交互识别纯逻辑（src/command-interaction.ts）。钉住：静态预扫
 * （read -p / read -sp / 裸 read、select 循环、交互命令前缀表、docker -it、
 * git 交互子命令、解释器 -i、login；注释行与空行跳过），以及运行时启发
 * detectWaitInput 的各正则分支（y/n、password、中文提示、冒号/问号结尾行
 * ——只看最后一段非空行）。
 */
import { describe, expect, it } from 'vitest'
import {
  DOCKER_ATTACH_RE,
  DOCKER_INTERACTIVE_RE,
  GIT_INTERACTIVE_RE,
  LOGIN_RE,
  READ_RE,
  SELECT_RE,
  WAIT_CHINESE_RE,
  WAIT_PASSWORD_RE,
  WAIT_PROMPT_END_RE,
  WAIT_YN_RE,
  detectWaitInput,
  isInteractiveCommandLine,
  scanInteractionPoints,
} from '../src/command-interaction.ts'

describe('scanInteractionPoints（静态预扫）', () => {
  it('READ_RE/SELECT_RE 命令位判定（导出正则面）', () => {
    expect(READ_RE.test('read -p "x" v')).toBe(true)
    expect(READ_RE.test('echo spread')).toBe(false)
    expect(READ_RE.test('echo already')).toBe(false)
    expect(SELECT_RE.test('select opt in a b')).toBe(true)
    expect(SELECT_RE.test('echo select opt in a b')).toBe(false)
  })

  it('read 家族：-p / -sp / 裸 read 命中，spread / already 不命中', () => {
    const points = scanInteractionPoints([
      '#!/bin/bash',
      'read -p "name? " name',
      'read -sp "password: " pass',
      'read answer',
      'echo spread',        // 行首非命令位 read 词：不命中
      'cat already.txt',    // 同上
      'while read line; do echo "$line"; done', // while 后的 read：命中
    ].join('\n'))
    const reads = points.filter(point => point.kind === 'read')
    expect(reads.map(point => point.line)).toEqual([2, 3, 4, 7])
  })

  it('select 循环命中', () => {
    const points = scanInteractionPoints('select opt in a b; do break; done')
    expect(points).toHaveLength(1)
    expect(points[0]?.kind).toBe('select')
  })

  it('交互命令前缀表：sudo/ssh/mysql 命中，VAR=value 赋值跳过，普通命令不命中', () => {
    expect(scanInteractionPoints('sudo rm /tmp/x').map(point => point.kind)).toEqual(['command'])
    expect(scanInteractionPoints('ssh user@host').map(point => point.kind)).toEqual(['command'])
    expect(scanInteractionPoints('mysql -uroot -p').map(point => point.kind)).toEqual(['command'])
    expect(scanInteractionPoints('FOO=1 sudo apt install x').map(point => point.kind)).toEqual(['command'])
    expect(scanInteractionPoints('echo sudo in a string')).toEqual([])
    expect(scanInteractionPoints('ls -la')).toEqual([])
  })

  it('docker：-it / attach 命中，无 -it 不命中；git rebase -i / am 命中', () => {
    expect(DOCKER_INTERACTIVE_RE.test('docker run -it alpine sh')).toBe(true)
    expect(DOCKER_INTERACTIVE_RE.test('docker exec -ti box sh')).toBe(true)
    expect(DOCKER_INTERACTIVE_RE.test('docker run alpine sh')).toBe(false)
    expect(DOCKER_ATTACH_RE.test('docker attach box')).toBe(true)
    expect(GIT_INTERACTIVE_RE.test('git rebase -i HEAD~3')).toBe(true)
    expect(GIT_INTERACTIVE_RE.test('git rebase --interactive HEAD~3')).toBe(true)
    expect(GIT_INTERACTIVE_RE.test('git am 0001-x.patch')).toBe(true)
    expect(GIT_INTERACTIVE_RE.test('git rebase HEAD~3')).toBe(false)
  })

  it('解释器 -i 与 login 命中（正则导出面）', () => {
    expect(isInteractiveCommandLine('bash -i')).toBe(true)
    expect(isInteractiveCommandLine('python3 -i script.py')).toBe(true)
    expect(LOGIN_RE.test('npm login')).toBe(true)
    expect(LOGIN_RE.test('pnpm login')).toBe(true)
    expect(LOGIN_RE.test('npm install')).toBe(false)
  })

  it('注释行与空行跳过；行号 1-based；一行最多记一条', () => {
    const points = scanInteractionPoints([
      '# read -p "comment"',
      '',
      'read -p "a" a && sudo rm x',
    ].join('\n'))
    expect(points).toHaveLength(1)
    expect(points[0]?.line).toBe(3)
    expect(points[0]?.kind).toBe('read')
  })
})

describe('detectWaitInput（运行时启发）', () => {
  it('y/n 与 [Y/n] 家族（y/n 需在括号内）', () => {
    expect(WAIT_YN_RE.test('Proceed? (y/n)')).toBe(true)
    expect(WAIT_YN_RE.test('Continue? [Y/n]')).toBe(true)
    expect(WAIT_YN_RE.test('Overwrite? (yes/no)')).toBe(true)
    expect(WAIT_YN_RE.test('installed 42 packages')).toBe(false)
    expect(detectWaitInput('Proceed? (y/n)')).toBe(true)
  })

  it('password 提示（英文与中文，含中文无冒号形态）', () => {
    expect(WAIT_PASSWORD_RE.test('password:')).toBe(true)
    expect(WAIT_PASSWORD_RE.test('Password：')).toBe(true)
    expect(WAIT_PASSWORD_RE.test('请输入密码')).toBe(true)
    expect(WAIT_PASSWORD_RE.test('total 42K')).toBe(false)
    expect(detectWaitInput('[sudo] password for aogg:')).toBe(true)
  })

  it('中文提示词分支', () => {
    expect(WAIT_CHINESE_RE.test('请输入用户名')).toBe(true)
    expect(WAIT_CHINESE_RE.test('是否继续?')).toBe(true)
    expect(WAIT_CHINESE_RE.test('是否覆盖已存在的文件?')).toBe(true)
    expect(WAIT_CHINESE_RE.test('完成 3 个文件')).toBe(false)
    expect(detectWaitInput('请选择要安装的版本')).toBe(true)
  })

  it('冒号/问号结尾只看最后一段非空行（banner 中段的冒号不算；行尾空行可跳过）', () => {
    expect(WAIT_PROMPT_END_RE.test('Enter tag:')).toBe(true)
    // 尾部空行跳过后，最后一行仍以冒号结尾 → 亮（提示符常见形态）。
    expect(detectWaitInput('Enter tag:\n')).toBe(true)
    // 最后一行是正常输出 → 不亮。
    expect(detectWaitInput('Enter tag:\ndone')).toBe(false)
    // 最后一行以冒号结尾 → 亮。
    expect(detectWaitInput('building...\nEnter tag:')).toBe(true)
    expect(detectWaitInput('要继续吗？')).toBe(true)
  })

  it('空串与纯空白不亮', () => {
    expect(detectWaitInput('')).toBe(false)
    expect(detectWaitInput('   ')).toBe(false)
  })
})
