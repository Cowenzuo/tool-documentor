/** 本地时间 ISO 格式（对齐 Qt ISODate：无时区后缀、无毫秒，如 2026-07-23T15:35:47） */
export function localIsoNow(): string {
  return toLocalIso(new Date())
}

export function toLocalIso(date: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}` +
    `T${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`
  )
}
