// server/weather.ts
// Daily observed weather for daily reports. Server-side so plain-LAN clients
// need no internet. Free/no-key providers: OSM Nominatim (geocode, usage
// policy requires a UA header) + Open-Meteo (hourly observed temps/conditions).

export interface DailyWeatherResult {
  hourly: { hour: string; tempF: number | null; condition: string }[];
  summary: string;
  temperature: string;
}

const geocodeCache = new Map<string, { lat: number; lon: number } | null>();

const WMO: Record<number, string> = {
  0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Fog', 51: 'Drizzle', 53: 'Drizzle', 55: 'Drizzle',
  56: 'Frz drizzle', 57: 'Frz drizzle', 61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
  66: 'Frz rain', 67: 'Frz rain', 71: 'Light snow', 73: 'Snow', 75: 'Heavy snow',
  77: 'Snow', 80: 'Showers', 81: 'Showers', 82: 'Heavy showers',
  85: 'Snow showers', 86: 'Snow showers', 95: 'Thunderstorm', 96: 'Thunderstorm', 99: 'Thunderstorm',
};

export const conditionForCode = (code: number | null | undefined): string =>
  code == null ? '—' : (WMO[code] ?? '—');

export function summarize(hourly: DailyWeatherResult['hourly']): { summary: string; temperature: string } {
  if (hourly.length === 0) return { summary: '', temperature: '' };

  const counts = new Map<string, number>();
  const order: string[] = [];
  for (const h of hourly) {
    if (h.condition === '—') continue;
    if (!counts.has(h.condition)) { counts.set(h.condition, 0); order.push(h.condition); }
    counts.set(h.condition, counts.get(h.condition)! + 1);
  }
  let summary = '';
  let best = -1;
  for (const cond of order) {
    const c = counts.get(cond)!;
    if (c > best) { best = c; summary = cond; }
  }

  const temps = hourly.map(h => h.tempF).filter((t): t is number => t != null);
  const temperature = temps.length === 0 ? '' : `${Math.min(...temps)}–${Math.max(...temps)}°F`;

  return { summary, temperature };
}

export async function geocodeAddress(address: string): Promise<{ lat: number; lon: number } | null> {
  if (geocodeCache.has(address)) return geocodeCache.get(address)!;

  const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(address);
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Frugal-Takeoff/2.7 (daily-report weather)' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) { geocodeCache.set(address, null); return null; }
  const data = await res.json();
  if (!Array.isArray(data) || data.length === 0) { geocodeCache.set(address, null); return null; }

  const result = { lat: Number(data[0].lat), lon: Number(data[0].lon) };
  geocodeCache.set(address, result);
  return result;
}

function hourLabel(h: number): string {
  if (h === 12) return '12 PM';
  if (h > 12) return `${h - 12} PM`;
  return `${h} AM`;
}

export async function fetchDailyWeather(lat: number, lon: number, date: string): Promise<DailyWeatherResult> {
  const daysAgo = Math.floor((Date.now() - new Date(date + 'T12:00:00').getTime()) / 86_400_000);
  const isArchive = daysAgo >= 8;
  const host = isArchive ? 'https://archive-api.open-meteo.com/v1/archive' : 'https://api.open-meteo.com/v1/forecast';
  const pastDays = isArchive ? '' : '&past_days=7';
  const url = `${host}?latitude=${lat}&longitude=${lon}&hourly=temperature_2m,weather_code&temperature_unit=fahrenheit&timezone=auto&start_date=${date}&end_date=${date}${pastDays}`;

  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Open-Meteo request failed: ${res.status}`);
  const data = await res.json();

  const codes: (number | null)[] = data.hourly.weather_code ?? data.hourly.weathercode ?? [];
  const hourly: DailyWeatherResult['hourly'] = [];
  for (let i = 0; i < data.hourly.time.length; i++) {
    const t: string = data.hourly.time[i];
    if (!t.startsWith(date)) continue;
    const match = /T(\d{2}):00$/.exec(t);
    if (!match) continue;
    const h = Number(match[1]);
    if (h < 6 || h > 18) continue;
    const temp = data.hourly.temperature_2m[i];
    hourly.push({
      hour: hourLabel(h),
      tempF: temp == null ? null : Math.round(temp),
      condition: conditionForCode(codes[i]),
    });
  }

  return { hourly, ...summarize(hourly) };
}
