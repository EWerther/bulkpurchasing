/**
 * Format a date value for display, always using UTC so that SQL Server
 * datetimes stored as midnight (no timezone) never roll back a day when
 * converted to local time.
 *
 * @param val   A Date object or ISO string from the API
 * @param opts  Extra Intl.DateTimeFormatOptions (merged with timeZone: 'UTC')
 */
export function fmtDate(
  val: string | Date | null | undefined,
  opts?: Omit<Intl.DateTimeFormatOptions, 'timeZone'>
): string {
  if (!val) return '—'
  return new Date(val).toLocaleDateString('en-US', { timeZone: 'UTC', ...opts })
}
