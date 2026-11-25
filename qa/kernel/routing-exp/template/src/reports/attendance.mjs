// Attendance figures for one session or a set of bookings.
export function attendanceSummary(bookings) {
  const active = bookings.filter((booking) => booking.status === 'active');
  const attended = active.filter((booking) => booking.attended === true).length;
  return {
    booked: active.length,
    attended,
    noShows: active.length - attended,
    // Whole percent, 0 when nobody was booked.
    rate: active.length === 0 ? 0 : Math.round((attended * 100) / active.length),
  };
}

/** Attendance per member id over many bookings: Map(memberId -> { booked, attended }). */
export function attendanceByMember(bookings) {
  const totals = new Map();
  for (const booking of bookings) {
    if (booking.status !== 'active') continue;
    const row = totals.get(booking.memberId) ?? { booked: 0, attended: 0 };
    row.booked += 1;
    if (booking.attended === true) row.attended += 1;
    totals.set(booking.memberId, row);
  }
  return totals;
}
