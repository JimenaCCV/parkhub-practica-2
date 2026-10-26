import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Types } from 'mongoose';
import { canExtendReservation, validateExtensionEndTime } from '../reservation.rules';

// Se reemplaza el modelo de Mongoose por funciones simuladas (mocks).
// Así las pruebas no necesitan una base de datos real y siempre dan lo mismo.
jest.mock('../reservation.model', () => ({
  Reservation: {
    findById: jest.fn(),
    find: jest.fn(),
    findOneAndUpdate: jest.fn()
  }
}));

import app from '../../../app';
import { Reservation } from '../reservation.model';

const mockedReservation = Reservation as unknown as {
  findById: jest.Mock<(...args: unknown[]) => Promise<unknown>>;
  find: jest.Mock<(...args: unknown[]) => Promise<unknown>>;
  findOneAndUpdate: jest.Mock<(...args: unknown[]) => Promise<unknown>>;
};

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

// Crea una reservación de prueba. Por defecto: ACTIVE, empezó hace 1 h y termina en 1 h.
function buildReservation(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    _id: new Types.ObjectId(),
    parkingSpotId: new Types.ObjectId(),
    startTime: new Date(now - HOUR),
    endTime: new Date(now + HOUR),
    status: 'ACTIVE',
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// Reglas puras (sin base de datos)
// ---------------------------------------------------------------------------
describe('validateExtensionEndTime', () => {
  const now = new Date('2026-10-25T10:00:00.000Z');
  const currentEnd = new Date('2026-10-25T11:00:00.000Z');

  test('returns the new date when it is after the current end', () => {
    // Arrange
    const newEndTime = '2026-10-25T12:00:00.000Z';

    // Act
    const result = validateExtensionEndTime(currentEnd, newEndTime, now);

    // Assert
    expect(result).toEqual(new Date(newEndTime));
  });

  test('accepts an extension of exactly one minute', () => {
    const result = validateExtensionEndTime(currentEnd, '2026-10-25T11:01:00.000Z', now);

    expect(result).toEqual(new Date('2026-10-25T11:01:00.000Z'));
  });

  test('returns null when the new end equals the current end', () => {
    const result = validateExtensionEndTime(currentEnd, '2026-10-25T11:00:00.000Z', now);

    expect(result).toBeNull();
  });

  test('returns null when the new end is before the current end', () => {
    const result = validateExtensionEndTime(currentEnd, '2026-10-25T10:30:00.000Z', now);

    expect(result).toBeNull();
  });

  test('returns null for an invalid date string', () => {
    const result = validateExtensionEndTime(currentEnd, 'not a date', now);

    expect(result).toBeNull();
  });

  test('returns null when the value is not a string', () => {
    expect(validateExtensionEndTime(currentEnd, undefined, now)).toBeNull();
    expect(validateExtensionEndTime(currentEnd, 1730000000000, now)).toBeNull();
  });
});

describe('canExtendReservation', () => {
  const now = new Date('2026-10-25T10:00:00.000Z');

  test('allows an ACTIVE reservation that has not ended', () => {
    expect(canExtendReservation('ACTIVE', new Date('2026-10-25T11:00:00.000Z'), now)).toBe(true);
  });

  test('rejects a CANCELLED reservation', () => {
    expect(canExtendReservation('CANCELLED', new Date('2026-10-25T11:00:00.000Z'), now)).toBe(false);
  });

  test('rejects a reservation that already ended', () => {
    expect(canExtendReservation('ACTIVE', new Date('2026-10-25T09:00:00.000Z'), now)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Endpoint completo: ruta + servicio + reglas, con el modelo simulado
// ---------------------------------------------------------------------------
describe('PATCH /api/reservations/:id/extend', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll((done) => {
    server = app.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${port}`;
      done();
    });
  });

  afterAll((done) => {
    server.close(() => done());
  });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  async function extend(id: string, body: unknown) {
    const response = await fetch(`${baseUrl}/api/reservations/${id}/extend`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  // ----- Happy Path --------------------------------------------------------
  test('CP-01 extends an active reservation by one hour and returns 200', async () => {
    // Arrange: reservación ACTIVE que termina en 1 h, sin otras reservaciones en el espacio.
    const reservation = buildReservation();
    const newEnd = new Date(reservation.endTime.getTime() + HOUR);
    mockedReservation.findById.mockResolvedValue(reservation);
    mockedReservation.find.mockResolvedValue([]);
    mockedReservation.findOneAndUpdate.mockResolvedValue({ ...reservation, endTime: newEnd });

    // Act
    const { status, body } = await extend(reservation._id.toString(), {
      endTime: newEnd.toISOString()
    });

    // Assert: 200, nueva hora final y se actualizó la MISMA reservación (no se creó otra).
    expect(status).toBe(200);
    expect(body.endTime).toBe(newEnd.toISOString());
    expect(body._id).toBe(reservation._id.toString());
    expect(mockedReservation.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: reservation._id, status: 'ACTIVE', endTime: reservation.endTime },
      { endTime: newEnd },
      { new: true }
    );
  });

  test('CP-02 extends when the next reservation of the spot starts after the new end', async () => {
    // Arrange
    const reservation = buildReservation();
    const newEnd = new Date(reservation.endTime.getTime() + HOUR);
    const later = buildReservation({
      parkingSpotId: reservation.parkingSpotId,
      startTime: new Date(newEnd.getTime() + HOUR),
      endTime: new Date(newEnd.getTime() + 2 * HOUR)
    });
    mockedReservation.findById.mockResolvedValue(reservation);
    mockedReservation.find.mockResolvedValue([later]);
    mockedReservation.findOneAndUpdate.mockResolvedValue({ ...reservation, endTime: newEnd });

    // Act
    const { status, body } = await extend(reservation._id.toString(), {
      endTime: newEnd.toISOString()
    });

    // Assert
    expect(status).toBe(200);
    expect(body.endTime).toBe(newEnd.toISOString());
  });

  // ----- Error Cases -------------------------------------------------------
  test('CP-03 returns 400 when the id is not a valid ObjectId', async () => {
    // Arrange
    const endTime = new Date(Date.now() + 2 * HOUR).toISOString();

    // Act
    const { status, body } = await extend('abc123', { endTime });

    // Assert: ni siquiera se consulta la base de datos.
    expect(status).toBe(400);
    expect(body.message).toBe('Invalid reservation ID');
    expect(mockedReservation.findById).not.toHaveBeenCalled();
  });

  test('CP-04 returns 404 when the reservation does not exist', async () => {
    // Arrange
    mockedReservation.findById.mockResolvedValue(null);
    const id = new Types.ObjectId().toString();

    // Act
    const { status, body } = await extend(id, {
      endTime: new Date(Date.now() + 2 * HOUR).toISOString()
    });

    // Assert
    expect(status).toBe(404);
    expect(body.message).toBe('Reservation not found');
    expect(mockedReservation.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('CP-05 returns 400 when the reservation is CANCELLED', async () => {
    const reservation = buildReservation({ status: 'CANCELLED' });
    mockedReservation.findById.mockResolvedValue(reservation);

    const { status, body } = await extend(reservation._id.toString(), {
      endTime: new Date(reservation.endTime.getTime() + HOUR).toISOString()
    });

    expect(status).toBe(400);
    expect(body.message).toBe('Only active reservations can be extended');
    expect(mockedReservation.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('CP-06 returns 400 when the reservation already ended', async () => {
    const reservation = buildReservation({
      startTime: new Date(Date.now() - 3 * HOUR),
      endTime: new Date(Date.now() - HOUR)
    });
    mockedReservation.findById.mockResolvedValue(reservation);

    const { status, body } = await extend(reservation._id.toString(), {
      endTime: new Date(Date.now() + HOUR).toISOString()
    });

    expect(status).toBe(400);
    expect(body.message).toBe('Reservation has already ended');
    expect(mockedReservation.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('CP-07 returns 400 when the new end is before the current end', async () => {
    const reservation = buildReservation();
    mockedReservation.findById.mockResolvedValue(reservation);

    const { status, body } = await extend(reservation._id.toString(), {
      endTime: new Date(reservation.endTime.getTime() - 30 * MINUTE).toISOString()
    });

    expect(status).toBe(400);
    expect(body.message).toBe('New end time must be a valid date after the current end time');
  });

  test('CP-08 returns 400 when endTime is missing or is not a valid date', async () => {
    const reservation = buildReservation();
    mockedReservation.findById.mockResolvedValue(reservation);

    const missing = await extend(reservation._id.toString(), {});
    const invalid = await extend(reservation._id.toString(), { endTime: 'mañana' });

    expect(missing.status).toBe(400);
    expect(invalid.status).toBe(400);
    expect(mockedReservation.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('CP-09 returns 409 when the extension overlaps another active reservation', async () => {
    // Arrange: otra reservación del mismo espacio empieza 30 min después del fin actual.
    const reservation = buildReservation();
    const other = buildReservation({
      parkingSpotId: reservation.parkingSpotId,
      startTime: new Date(reservation.endTime.getTime() + 30 * MINUTE),
      endTime: new Date(reservation.endTime.getTime() + 2 * HOUR)
    });
    mockedReservation.findById.mockResolvedValue(reservation);
    mockedReservation.find.mockResolvedValue([other]);

    // Act: se pide extender 1 h (choca con la otra).
    const { status, body } = await extend(reservation._id.toString(), {
      endTime: new Date(reservation.endTime.getTime() + HOUR).toISOString()
    });

    // Assert
    expect(status).toBe(409);
    expect(body.message).toBe('Parking spot is already reserved during the extension');
    expect(mockedReservation.findOneAndUpdate).not.toHaveBeenCalled();
  });

  // ----- Edge Cases --------------------------------------------------------
  test('CP-10 accepts an extension of exactly one minute', async () => {
    const reservation = buildReservation();
    const newEnd = new Date(reservation.endTime.getTime() + MINUTE);
    mockedReservation.findById.mockResolvedValue(reservation);
    mockedReservation.find.mockResolvedValue([]);
    mockedReservation.findOneAndUpdate.mockResolvedValue({ ...reservation, endTime: newEnd });

    const { status, body } = await extend(reservation._id.toString(), {
      endTime: newEnd.toISOString()
    });

    expect(status).toBe(200);
    expect(body.endTime).toBe(newEnd.toISOString());
  });

  test('CP-11 returns 400 when the new end is equal to the current end', async () => {
    const reservation = buildReservation();
    mockedReservation.findById.mockResolvedValue(reservation);

    const { status } = await extend(reservation._id.toString(), {
      endTime: reservation.endTime.toISOString()
    });

    expect(status).toBe(400);
    expect(mockedReservation.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('CP-12 allows the new end to touch exactly the start of the next reservation', async () => {
    // Arrange: la siguiente reservación empieza justo a la nueva hora final.
    const reservation = buildReservation();
    const newEnd = new Date(reservation.endTime.getTime() + HOUR);
    const next = buildReservation({
      parkingSpotId: reservation.parkingSpotId,
      startTime: newEnd,
      endTime: new Date(newEnd.getTime() + HOUR)
    });
    mockedReservation.findById.mockResolvedValue(reservation);
    mockedReservation.find.mockResolvedValue([next]);
    mockedReservation.findOneAndUpdate.mockResolvedValue({ ...reservation, endTime: newEnd });

    // Act
    const { status } = await extend(reservation._id.toString(), {
      endTime: newEnd.toISOString()
    });

    // Assert: tocarse en el borde no es conflicto.
    expect(status).toBe(200);
  });

  test('CP-13 returns 409 when a duplicated request already changed the reservation', async () => {
    // Arrange: entre la lectura y la actualización otra solicitud igual ya cambió endTime,
    // por eso la actualización condicionada no encuentra el documento.
    const reservation = buildReservation();
    mockedReservation.findById.mockResolvedValue(reservation);
    mockedReservation.find.mockResolvedValue([]);
    mockedReservation.findOneAndUpdate.mockResolvedValue(null);

    // Act
    const { status, body } = await extend(reservation._id.toString(), {
      endTime: new Date(reservation.endTime.getTime() + HOUR).toISOString()
    });

    // Assert
    expect(status).toBe(409);
    expect(body.message).toBe('Reservation changed during the request, try again');
  });

  test('CP-14 returns 500 when the database fails unexpectedly', async () => {
    mockedReservation.findById.mockRejectedValue(new Error('DB down'));

    const { status, body } = await extend(new Types.ObjectId().toString(), {
      endTime: new Date(Date.now() + 2 * HOUR).toISOString()
    });

    expect(status).toBe(500);
    expect(body.message).toBe('Could not extend reservation');
  });
});
