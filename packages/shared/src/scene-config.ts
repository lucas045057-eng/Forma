export type Vec3 = [number, number, number];

export type SceneConfig = {
  model: string;
  hero: {
    camera: { position: Vec3; target: Vec3; fov: number };
    model: { rotation: Vec3; scale: number };
    lights: {
      key: { intensity: number; color: string; direction: Vec3 };
      ambient: number;
    };
  };
  scroll: Array<{
    at: number;
    model?: { rotation: Vec3 };
    parts?: Record<string, { offset: Vec3 }>;
  }>;
};

const modelPattern = '^(?:|/assets/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*/)*[A-Za-z0-9_-][A-Za-z0-9._-]*)(?![\\s\\S])';
const partPattern = '^(?!(?:__proto__|constructor|prototype)$)[A-Za-z_][A-Za-z0-9_-]*(?![\\s\\S])';
const colorPattern = '^#[0-9a-fA-F]{6}(?![\\s\\S])';
const vec3Schema = {
  type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3,
} as const;

export const sceneConfigSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $comment: 'All numbers must be finite. Scroll at values must be strictly increasing; ordering is checked by isSceneConfig, not draft-07.',
  type: 'object',
  additionalProperties: false,
  required: ['model', 'hero', 'scroll'],
  properties: {
    model: { type: 'string', pattern: modelPattern },
    hero: {
      type: 'object', additionalProperties: false,
      required: ['camera', 'model', 'lights'],
      properties: {
        camera: {
          type: 'object', additionalProperties: false,
          required: ['position', 'target', 'fov'],
          properties: {
            position: vec3Schema, target: vec3Schema,
            fov: { type: 'number', minimum: 1, maximum: 120 },
          },
        },
        model: {
          type: 'object', additionalProperties: false,
          required: ['rotation', 'scale'],
          properties: {
            rotation: vec3Schema,
            scale: { type: 'number', minimum: 0.01, maximum: 100 },
          },
        },
        lights: {
          type: 'object', additionalProperties: false,
          required: ['key', 'ambient'],
          properties: {
            key: {
              type: 'object', additionalProperties: false,
              required: ['intensity', 'color', 'direction'],
              properties: {
                intensity: { type: 'number', minimum: 0, maximum: 20 },
                color: { type: 'string', pattern: colorPattern },
                direction: vec3Schema,
              },
            },
            ambient: { type: 'number', minimum: 0, maximum: 20 },
          },
        },
      },
    },
    scroll: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['at'],
        properties: {
          at: { type: 'number', minimum: 0, maximum: 1 },
          model: {
            type: 'object', additionalProperties: false, required: ['rotation'],
            properties: { rotation: vec3Schema },
          },
          parts: {
            type: 'object', propertyNames: { pattern: partPattern },
            additionalProperties: {
              type: 'object', additionalProperties: false, required: ['offset'],
              properties: { offset: vec3Schema },
            },
          },
        },
      },
    },
  },
} as const;

const modelRegex = new RegExp(modelPattern);
const partRegex = new RegExp(partPattern);
const colorRegex = new RegExp(colorPattern);

function fields(value: unknown, required: string[], optional: string[] = []): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}

function numberIn(value: unknown, min = -Infinity, max = Infinity): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function vec3(value: unknown): value is Vec3 {
  return Array.isArray(value) && value.length === 3
    && numberIn(value[0]) && numberIn(value[1]) && numberIn(value[2]);
}

export function isSceneConfig(value: unknown): value is SceneConfig {
  if (!fields(value, ['model', 'hero', 'scroll'])
    || typeof value.model !== 'string' || !modelRegex.test(value.model)
    || !fields(value.hero, ['camera', 'model', 'lights']) || !Array.isArray(value.scroll)) return false;

  const { camera, model, lights } = value.hero;
  if (!fields(camera, ['position', 'target', 'fov'])
    || !vec3(camera.position) || !vec3(camera.target) || !numberIn(camera.fov, 1, 120)
    || !fields(model, ['rotation', 'scale']) || !vec3(model.rotation) || !numberIn(model.scale, 0.01, 100)
    || !fields(lights, ['key', 'ambient']) || !numberIn(lights.ambient, 0, 20)
    || !fields(lights.key, ['intensity', 'color', 'direction'])
    || !numberIn(lights.key.intensity, 0, 20) || !vec3(lights.key.direction)
    || typeof lights.key.color !== 'string' || !colorRegex.test(lights.key.color)) return false;

  let previousAt = -Infinity;
  for (const frame of value.scroll) {
    if (!fields(frame, ['at'], ['model', 'parts'])
      || !numberIn(frame.at, 0, 1) || frame.at <= previousAt) return false;
    previousAt = frame.at;
    if (frame.model !== undefined
      && (!fields(frame.model, ['rotation']) || !vec3(frame.model.rotation))) return false;
    if (frame.parts !== undefined) {
      if (typeof frame.parts !== 'object' || frame.parts === null || Array.isArray(frame.parts)) return false;
      for (const [name, part] of Object.entries(frame.parts)) {
        if (!partRegex.test(name) || !fields(part, ['offset']) || !vec3(part.offset)) return false;
      }
    }
  }
  return true;
}

export const defaultSceneConfig: SceneConfig = {
  model: '',
  hero: {
    camera: { position: [1.6, 1.1, 1.6], target: [0, 0.5, 0], fov: 35 },
    model: { rotation: [0, 0.52, 0], scale: 1 },
    lights: { key: { intensity: 3, color: '#ffd9a8', direction: [3, 5, 4] }, ambient: 1.2 },
  },
  scroll: [],
};
