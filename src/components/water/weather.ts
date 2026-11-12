import { MathUtils, Matrix4, Vector3 } from 'three'
import { getMoonDirectionECEF, getSunDirectionECEF } from '@takram/three-atmosphere'
import { Ellipsoid, Geodetic } from '@takram/three-geospatial'
import type { WaterSettings } from './settings'

// 采用固定的非闰年历，保证 dayOfYear 1–365 在不同机器上完全一致。
export const WEATHER_YEAR = 2026
export const WEATHER_LONGITUDE = 139.8146
export const WEATHER_LATITUDE = 35.7455
export const weatherOrigin = new Geodetic(MathUtils.degToRad(WEATHER_LONGITUDE), MathUtils.degToRad(WEATHER_LATITUDE)).toECEF()
// 海洋坐标：X 向东，Y 向上，Z 向南。
export const worldToECEF = Ellipsoid.WGS84.getEastNorthUpFrame(weatherOrigin)
  .multiply(new Matrix4().makeRotationX(Math.PI / 2))
const ecefToWorld = worldToECEF.clone().invert()
const hoursPerYear = 365 * 24

export interface WeatherSnapshot {
  dayOfYear: number
  timeOfDay: number
  sunElevation: number
  sunAzimuth: number
}

export function normalizeLocalDate(dayOfYear: number, timeOfDay: number) {
  const day = Number.isFinite(dayOfYear) ? MathUtils.clamp(Math.floor(dayOfYear), 1, 365) : 170
  const hour = Number.isFinite(timeOfDay) ? timeOfDay : 15
  const total = MathUtils.euclideanModulo((day - 1) * 24 + hour, hoursPerYear)
  return { dayOfYear: Math.floor(total / 24) + 1, timeOfDay: total % 24 }
}

export function localWeatherDate(dayOfYear: number, timeOfDay: number): Date {
  // 参考实现使用当地平太阳时（经度 / 15），而不是电脑时区。
  return new Date(Date.UTC(WEATHER_YEAR, 0, 1) + ((dayOfYear - 1) * 24 + timeOfDay - WEATHER_LONGITUDE / 15) * 3600000)
}

export function formatWeatherDay(dayOfYear: number): string {
  const date = new Date(Date.UTC(WEATHER_YEAR, 0, dayOfYear))
  return `${String(date.getUTCMonth() + 1).padStart(2, '0')} / ${String(date.getUTCDate()).padStart(2, '0')}`
}

/** 持有独立的云层时钟与天体时钟，由 OceanScene 的单个 RAF 驱动。 */
export class WeatherSystem {
  dayOfYear = 170
  timeOfDay = 15
  cloudTime = 0
  readonly sunDirection = new Vector3()
  readonly moonDirection = new Vector3()

  constructor(settings: Pick<WaterSettings, 'dayOfYear' | 'timeOfDay'>) {
    this.setDate(settings.dayOfYear, settings.timeOfDay)
  }

  setDate(dayOfYear: number, timeOfDay: number) {
    Object.assign(this, normalizeLocalDate(dayOfYear, timeOfDay))
    const date = localWeatherDate(this.dayOfYear, this.timeOfDay)
    getSunDirectionECEF(date, this.sunDirection, weatherOrigin).transformDirection(ecefToWorld)
    getMoonDirectionECEF(date, this.moonDirection, weatherOrigin).transformDirection(ecefToWorld)
  }

  advance(deltaSeconds: number, settings: Pick<WaterSettings, 'paused' | 'animateTime' | 'timeSpeed' | 'animateClouds' | 'cloudSpeed'>): boolean {
    if (settings.paused || !Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return false
    if (settings.animateClouds && Number.isFinite(settings.cloudSpeed)) this.cloudTime += deltaSeconds * MathUtils.clamp(settings.cloudSpeed, 0, 5)
    if (!settings.animateTime || !Number.isFinite(settings.timeSpeed) || settings.timeSpeed === 0) return false
    // 与参考实现 60 FPS 时的速度对齐，并按真实经过时间积分，
    // 使高/低刷新率屏幕的推进速度一致。速度为负则反向。
    this.setDate(this.dayOfYear, this.timeOfDay + deltaSeconds * 60 * MathUtils.clamp(settings.timeSpeed, -0.5, 0.5))
    return true
  }

  snapshot(): WeatherSnapshot {
    return {
      dayOfYear: this.dayOfYear, timeOfDay: this.timeOfDay,
      sunElevation: MathUtils.radToDeg(Math.asin(MathUtils.clamp(this.sunDirection.y, -1, 1))),
      sunAzimuth: MathUtils.euclideanModulo(MathUtils.radToDeg(Math.atan2(this.sunDirection.x, -this.sunDirection.z)), 360),
    }
  }
}
