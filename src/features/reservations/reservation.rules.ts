export function validateReservationPeriod(startTime: unknown, endTime: unknown) {
  if (typeof startTime !== 'string' || typeof endTime !== 'string') {
    return null;
  }

  const start = new Date(startTime);
  const end = new Date(endTime);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end) {
    return null;
  }

  return { start, end };
}

export function hasTimeConflict(
  newStart: Date,
  newEnd: Date,
  existingStart: Date,
  existingEnd: Date
) {
  return newStart < existingEnd && newEnd > existingStart;
}

export function canReserveSpot(active: boolean, hasConflict: boolean) {
  return active && !hasConflict;
}

export function validateExtensionEndTime(
  currentEnd: Date,
  newEndTime: unknown,
  now: Date
): Date | null {
  // La nueva hora debe llegar como texto ISO, igual que en createReservation.
  if (typeof newEndTime !== 'string') {
    return null;
  }

  const newEnd = new Date(newEndTime);

  // Se rechaza si la fecha es inválida, si no es posterior a la hora final
  // actual o si ya quedó en el pasado.
  if (Number.isNaN(newEnd.getTime()) || newEnd <= currentEnd || newEnd <= now) {
    return null;
  }

  return newEnd;
}

export function canExtendReservation(status: string, currentEnd: Date, now: Date) {
  // Solo se puede extender una reservación ACTIVE que todavía no termina.
  return status === 'ACTIVE' && currentEnd > now;
}
