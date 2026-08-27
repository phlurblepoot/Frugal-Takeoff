// server/weather.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { conditionForCode, summarize, geocodeAddress, fetchDailyWeather } from './weather';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('conditionForCode', () => {
  it('maps known WMO codes', () => {
    expect(conditionForCode(0)).toBe('Clear');
    expect(conditionForCode(2)).toBe('Partly cloudy');
    expect(conditionForCode(63)).toBe('Rain');
    expect(conditionForCode(95)).toBe('Thunderstorm');
  });
  it('returns em dash for undefined/unknown codes', () => {
    expect(conditionForCode(undefined)).toBe('—');
    expect(conditionForCode(null)).toBe('—');
    expect(conditionForCode(12345)).toBe('—');
  });
});

describe('summarize', () => {
  it('picks the most frequent condition (ties: first seen)', () => {
    const hourly = [
      { hour: '6 AM', tempF: 60, condition: 'Clear' },
      { hour: '7 AM', tempF: 62, condition: 'Clear' },
      { hour: '8 AM', tempF: 64, condition: 'Rain' },
    ];
    expect(summarize(hourly).summary).toBe('Clear');
  });
  it('computes temperature range from min/max, rounding', () => {
    const hourly = [
      { hour: '6 AM', tempF: 58, condition: 'Clear' },
      { hour: '7 AM', tempF: 74, condition: 'Clear' },
      { hour: '8 AM', tempF: 65, condition: 'Clear' },
    ];
    expect(summarize(hourly).temperature).toBe('58–74°F');
  });
  it('returns empty temperature when all temps are null', () => {
    const hourly = [
      { hour: '6 AM', tempF: null, condition: 'Clear' },
      { hour: '7 AM', tempF: null, condition: 'Rain' },
    ];
    expect(summarize(hourly).temperature).toBe('');
  });
  it('returns empty summary/temperature for an empty array', () => {
    expect(summarize([])).toEqual({ summary: '', temperature: '' });
  });
});

describe('geocodeAddress', () => {
  it('returns lat/lon parsed from a mocked Nominatim response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ lat: '26.0521', lon: '-80.1425' }],
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await geocodeAddress('123 Main St, Dania Beach, FL');
    expect(result).toEqual({ lat: 26.0521, lon: -80.1425 });
  });

  it('sends a User-Agent header', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ lat: '26.0521', lon: '-80.1425' }],
    });
    vi.stubGlobal('fetch', fetchMock);
    await geocodeAddress('456 Oak Ave');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ headers: expect.objectContaining({ 'User-Agent': expect.any(String) }) }),
    );
  });

  it('returns null on empty array response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => [] });
    vi.stubGlobal('fetch', fetchMock);
    const result = await geocodeAddress('nowhere at all');
    expect(result).toBeNull();
  });

  it('returns null when res.ok is false', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, json: async () => [] });
    vi.stubGlobal('fetch', fetchMock);
    const result = await geocodeAddress('bad address');
    expect(result).toBeNull();
  });

  it('does not cache a transient (!ok) failure — a later successful call still hits fetch and succeeds', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, json: async () => [] })
      .mockResolvedValueOnce({ ok: true, json: async () => [{ lat: '1', lon: '2' }] });
    vi.stubGlobal('fetch', fetchMock);
    const uniqueAddress = `retry-after-failure-${Math.random()}`;
    const first = await geocodeAddress(uniqueAddress);
    expect(first).toBeNull();
    const second = await geocodeAddress(uniqueAddress);
    expect(second).toEqual({ lat: 1, lon: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('caches by address and does not hit fetch again for a repeat call', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ lat: '10', lon: '20' }],
    });
    vi.stubGlobal('fetch', fetchMock);
    const uniqueAddress = `789 Cache Test Blvd ${Math.random()}`;
    const first = await geocodeAddress(uniqueAddress);
    const second = await geocodeAddress(uniqueAddress);
    expect(first).toEqual({ lat: 10, lon: 20 });
    expect(second).toEqual({ lat: 10, lon: 20 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('fetchDailyWeather', () => {
  function mockMeteoPayload() {
    // Build a full-day hourly series (00:00 through 23:00) with a fixed date.
    const time: string[] = [];
    const temperature_2m: number[] = [];
    const weather_code: number[] = [];
    for (let h = 0; h < 24; h++) {
      const hh = String(h).padStart(2, '0');
      time.push(`2026-08-20T${hh}:00`);
      temperature_2m.push(50 + h);
      weather_code.push(h % 2 === 0 ? 0 : 63);
    }
    return { hourly: { time, temperature_2m, weather_code } };
  }

  it('returns only the 6 AM-6 PM rows with correct hour labels and rounded temps', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => mockMeteoPayload() });
    vi.stubGlobal('fetch', fetchMock);
    const result = await fetchDailyWeather(26.05, -80.14, '2026-08-20');
    expect(result.hourly).toHaveLength(13); // 6..18 inclusive
    expect(result.hourly[0]).toEqual({ hour: '6 AM', tempF: 56, condition: 'Clear' });
    expect(result.hourly[6]).toEqual({ hour: '12 PM', tempF: 62, condition: 'Clear' });
    expect(result.hourly[7]).toEqual({ hour: '1 PM', tempF: 63, condition: 'Rain' });
    expect(result.hourly[12]).toEqual({ hour: '6 PM', tempF: 68, condition: 'Clear' });
  });

  it('tolerates the legacy weathercode key', async () => {
    const payload = mockMeteoPayload() as any;
    payload.hourly.weathercode = payload.hourly.weather_code;
    delete payload.hourly.weather_code;
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => payload });
    vi.stubGlobal('fetch', fetchMock);
    const result = await fetchDailyWeather(26.05, -80.14, '2026-08-20');
    expect(result.hourly[0].condition).toBe('Clear');
  });

  it('picks the archive host for a date >= 8 days ago, with no past_days param', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => mockMeteoPayload() });
    vi.stubGlobal('fetch', fetchMock);
    const old = new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10);
    await fetchDailyWeather(26.05, -80.14, old);
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain('archive-api.open-meteo.com');
    expect(calledUrl).not.toContain('past_days');
  });

  it('picks the forecast host for a recent date, with no past_days param', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => mockMeteoPayload() });
    vi.stubGlobal('fetch', fetchMock);
    const recent = new Date().toISOString().slice(0, 10);
    await fetchDailyWeather(26.05, -80.14, recent);
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain('api.open-meteo.com');
    expect(calledUrl).not.toContain('archive-api');
    // Open-Meteo rejects past_days when start_date/end_date are present
    // (HTTP 400 "mutually exclusive") — verified live against the real API.
    expect(calledUrl).not.toContain('past_days');
  });
});
