import { isValidObjectId } from 'mongoose';
import { ParkingSpot } from '../parking-spots/parking-spot.model';
import { Reservation } from './reservation.model';
import {
  canExtendReservation,
  canReserveSpot,
  hasTimeConflict,
  validateExtensionEndTime,
  validateReservationPeriod
} from './reservation.rules';

export class ReservationError extends Error {
  constructor(public status: 400 | 404 | 409, message: string) {
    super(message);
  }
}

export async function getReservations() {
  return Reservation.find().populate('parkingSpotId', 'number').sort({ startTime: -1 });
}

export async function createReservation(input: {
  parkingSpotId: unknown;
  startTime: unknown;
  endTime: unknown;
}) {
  if (typeof input.parkingSpotId !== 'string' || !isValidObjectId(input.parkingSpotId)) {
    throw new ReservationError(400, 'Invalid parking spot ID');
  }

  const period = validateReservationPeriod(input.startTime, input.endTime);
  if (!period) {
    throw new ReservationError(400, 'Start time must be before end time');
  }

  const spot = await ParkingSpot.findById(input.parkingSpotId);
  if (!spot) {
    throw new ReservationError(404, 'Parking spot not found');
  }

  if (!spot.active) {
    throw new ReservationError(409, 'Parking spot is not active');
  }

  const overlappingReservations = await Reservation.find({
    parkingSpotId: spot._id,
    status: 'ACTIVE',
    startTime: { $lt: period.end },
    endTime: { $gt: period.start }
  });

  const hasConflict = overlappingReservations.some((reservation) =>
    hasTimeConflict(period.start, period.end, reservation.startTime, reservation.endTime)
  );

  if (!canReserveSpot(spot.active, hasConflict)) {
    throw new ReservationError(409, 'Parking spot is not available for this time range');
  }

  return Reservation.create({
    parkingSpotId: spot._id,
    startTime: period.start,
    endTime: period.end,
    status: 'ACTIVE'
  });
}

export async function cancelReservation(id: string) {
  if (!isValidObjectId(id)) {
    return null;
  }

  return Reservation.findByIdAndUpdate(id, { status: 'CANCELLED' }, { new: true });
}

export async function extendReservation(id: string, endTime: unknown) {
  // 1. El id debe tener formato de ObjectId.
  if (!isValidObjectId(id)) {
    throw new ReservationError(400, 'Invalid reservation ID');
  }

  // 2. La reservación debe existir.
  const reservation = await Reservation.findById(id);
  if (!reservation) {
    throw new ReservationError(404, 'Reservation not found');
  }

  // 3. Solo se extienden reservaciones ACTIVE.
  if (reservation.status !== 'ACTIVE') {
    throw new ReservationError(400, 'Only active reservations can be extended');
  }

  // 4. La reservación no debe haber terminado.
  const now = new Date();
  if (!canExtendReservation(reservation.status, reservation.endTime, now)) {
    throw new ReservationError(400, 'Reservation has already ended');
  }

  // 5. La nueva hora final debe ser válida y posterior a la actual.
  const newEnd = validateExtensionEndTime(reservation.endTime, endTime, now);
  if (!newEnd) {
    throw new ReservationError(400, 'New end time must be a valid date after the current end time');
  }

  // 6. El tramo agregado (fin actual -> nuevo fin) no debe chocar con otra
  //    reservación ACTIVE del mismo espacio. Se excluye la propia reservación.
  const overlappingReservations = await Reservation.find({
    _id: { $ne: reservation._id },
    parkingSpotId: reservation.parkingSpotId,
    status: 'ACTIVE',
    startTime: { $lt: newEnd },
    endTime: { $gt: reservation.endTime }
  });

  const hasConflict = overlappingReservations.some((other) =>
    hasTimeConflict(reservation.endTime, newEnd, other.startTime, other.endTime)
  );

  if (hasConflict) {
    throw new ReservationError(409, 'Parking spot is already reserved during the extension');
  }

  // 7. Se actualiza la misma reservación (no se crea otra). La condición sobre
  //    endTime evita que dos solicitudes iguales al mismo tiempo se apliquen dos veces.
  const updated = await Reservation.findOneAndUpdate(
    { _id: reservation._id, status: 'ACTIVE', endTime: reservation.endTime },
    { endTime: newEnd },
    { new: true }
  );

  if (!updated) {
    throw new ReservationError(409, 'Reservation changed during the request, try again');
  }

  return updated;
}
