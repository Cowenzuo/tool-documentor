/** captions.test.ts — 题注手写序号剥离规则的单测。 */

import { describe, expect, it } from 'vitest'
import { stripCaptionNumber } from '../src/captions'

describe('stripCaptionNumber（剥离手写题注序号，编号交给样式自动生成）', () => {
  it.each([
    ['表1 引用文档', '引用文档'],
    ['表1　引用文档', '引用文档'],
    ['表12 主要技术指标', '主要技术指标'],
    ['图2　系统组成', '系统组成'],
    ['图 3 部署视图', '部署视图'],
    ['图3部署视图', '部署视图'],
    ['表1', ''],
    ['引用文档（表1 的延续）', '引用文档（表1 的延续）'],
    ['第一章 范围', '第一章 范围'],
    ['图2-1 数据流', '数据流'],
    [' 表3 前后带空格的题注 ', '前后带空格的题注']
  ])('strip(%j) = %j', (input, expected) => {
    expect(stripCaptionNumber(input)).toBe(expected)
  })
})
