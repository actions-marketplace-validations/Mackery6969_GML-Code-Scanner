import data from "./builtins.json" with { type: "json" };
import { F_DEPRECATED, F_PURE, type RuntimeSpec, V_DEPRECATED, V_INSTANCE, V_READONLY } from "./runtime-spec.ts";

type FunctionEntry = [minArgs: number, maxArgs: number, returnType: string, flags: number, runtimeMask: number];
type VariableEntry = [type: string, flags: number, runtimeMask: number];

export interface BuiltinFunction {
  name: string;
  minArgs: number;
  /** -1 when variadic */
  maxArgs: number;
  returnType: string;
  deprecated: boolean;
  pure: boolean;
  runtimeMask: number;
}

export interface BuiltinVariable {
  name: string;
  type: string;
  deprecated: boolean;
  readonly: boolean;
  instance: boolean;
  constant: boolean;
  runtimeMask: number;
}

const functions = data.functions as unknown as Record<string, FunctionEntry>;
const variables = data.variables as unknown as Record<string, VariableEntry>;
const constants = data.constants as unknown as Record<string, VariableEntry>;

const runtimes: string[] = [...data.runtimes];

/** Runtime versions the database covers: the bundled ones newest first, then any added with addRuntime(). */
export const KNOWN_RUNTIMES: readonly string[] = runtimes;

/**
 * Adds an installed runtime (e.g. one set up by bscotch/igor-setup) to the database, so
 * projects on its release line get exact availability checks. Symbols keep the bundled
 * signatures; ones the bundled runtimes lack are added. Returns the runtime index.
 */
export function addRuntime(spec: RuntimeSpec): number {
  const existing = runtimes.indexOf(spec.version);
  if (existing >= 0) return existing;
  if (runtimes.length >= 31) throw new Error("Too many GameMaker runtimes loaded.");
  const index = runtimes.push(spec.version) - 1;
  const bit = 1 << index;
  for (const [name, [min, max, returnType, flags]] of spec.functions) {
    if (Object.hasOwn(functions, name)) functions[name][4] |= bit;
    else functions[name] = [min, max, returnType, flags, bit];
  }
  for (const [table, source] of [
    [variables, spec.variables],
    [constants, spec.constants],
  ] as const) {
    for (const [name, [type, flags]] of source) {
      if (Object.hasOwn(table, name)) table[name][2] |= bit;
      else table[name] = [type, flags, bit];
    }
  }
  return index;
}

export function getBuiltinFunction(name: string): BuiltinFunction | undefined {
  if (!Object.hasOwn(functions, name)) return undefined;
  const [minArgs, maxArgs, returnType, flags, runtimeMask] = functions[name];
  return {
    name,
    minArgs,
    maxArgs,
    returnType,
    deprecated: (flags & F_DEPRECATED) !== 0,
    pure: (flags & F_PURE) !== 0,
    runtimeMask,
  };
}

export function getBuiltinVariable(name: string): BuiltinVariable | undefined {
  const isConst = Object.hasOwn(constants, name);
  if (!isConst && !Object.hasOwn(variables, name)) return undefined;
  const [type, flags, runtimeMask] = isConst ? constants[name] : variables[name];
  return {
    name,
    type,
    deprecated: (flags & V_DEPRECATED) !== 0,
    readonly: isConst || (flags & V_READONLY) !== 0,
    instance: (flags & V_INSTANCE) !== 0,
    constant: isConst,
    runtimeMask,
  };
}

export function isBuiltinFunction(name: string): boolean {
  return Object.hasOwn(functions, name);
}

/** Built-in variables, constants and keywords usable as bare identifiers. */
export function isBuiltinIdentifier(name: string): boolean {
  return Object.hasOwn(variables, name) || Object.hasOwn(constants, name) || BUILTIN_KEYWORD_VALUES.has(name);
}

const BUILTIN_KEYWORD_VALUES = new Set(["self", "other", "all", "noone", "global", "undefined", "true", "false", "infinity", "NaN", "pi"]);

/** `argument0`..`argument15`, `argument`, `argument_count` */
export function isArgumentVariable(name: string): boolean {
  return name === "argument" || name === "argument_count" || /^argument\d+$/.test(name);
}

export function listBuiltinFunctionNames(): string[] {
  return Object.keys(functions);
}

/**
 * Resolves a project's runtime/IDE version (e.g. `2023.1.1.62`) to the index of a
 * runtime in the database with the same `year.minor`, or -1 when none matches.
 * Availability checks are only safe against an exact release line. An exact version
 * wins, then the most recently added runtime of that line.
 */
export function resolveRuntimeIndex(version: string | undefined): number {
  if (!version) return -1;
  const exact = runtimes.indexOf(version);
  if (exact >= 0) return exact;
  const line = version.split(".").slice(0, 2).join(".");
  return runtimes.findLastIndex((v) => v.split(".").slice(0, 2).join(".") === line);
}

export function availableInRuntime(runtimeMask: number, runtimeIndex: number): boolean {
  return runtimeIndex < 0 || (runtimeMask & (1 << runtimeIndex)) !== 0;
}

/**
 * GameMaker Studio 1.x functions removed in GMS2, with their replacements. Used to
 * give actionable messages when legacy code calls them.
 */
export const LEGACY_REPLACEMENTS: Record<string, string> = {
  instance_create: "instance_create_layer() or instance_create_depth()",
  execute_string: "a function or method (runtime code evaluation was removed)",
  execute_file: "a function or method (runtime code evaluation was removed)",
  object_event_add: "a method variable",
  background_get_width: "sprite_get_width()",
  background_get_height: "sprite_get_height()",
  draw_background: "draw_sprite() or a background layer",
  draw_background_ext: "draw_sprite_ext() or a background layer",
  sound_play: "audio_play_sound()",
  sound_loop: "audio_play_sound() with loop = true",
  sound_stop: "audio_stop_sound()",
  sound_isplaying: "audio_is_playing()",
  view_xview: "camera_get_view_x(view_camera[0])",
  view_yview: "camera_get_view_y(view_camera[0])",
  d3d_start: "gpu_set_ztestenable() / gpu_set_zwriteenable()",
  d3d_end: "gpu_set_ztestenable(false)",
  d3d_set_fog: "gpu_set_fog()",
  d3d_transform_set_identity: "matrix_set(matrix_world, matrix_build_identity())",
  draw_set_blend_mode: "gpu_set_blendmode()",
  draw_set_blend_mode_ext: "gpu_set_blendmode_ext()",
  draw_set_alpha_test: "gpu_set_alphatestenable()",
  texture_set_interpolation: "gpu_set_texfilter()",
  texture_set_repeat: "gpu_set_texrepeat()",
  array_length_1d: "array_length()",
  array_length_2d: "array_length(array[index])",
  array_height_2d: "array_length()",
  joystick_exists: "gamepad_is_connected()",
  window_set_region_size: "window_set_size()",
  instance_change: "instance_destroy() + instance_create_*()",
  room_speed: "game_get_speed(gamespeed_fps)",
};
