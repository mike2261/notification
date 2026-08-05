/** biome-ignore-all lint/complexity/noBannedTypes: ask hono */
import type { ArkErrors, Type } from "arktype";
import { type } from "arktype";
import type { Context, Env, MiddlewareHandler, TypedResponse, ValidationTargets } from "hono";
import { validator } from "hono/validator";
import { AppError } from "./error";

export type Hook<T, E extends Env, P extends string, O = {}> = (
  result: { success: false; data: unknown; errors: ArkErrors } | { success: true; data: T },
  c: Context<E, P>,
) => Response | Promise<Response> | undefined | Promise<Response | undefined> | TypedResponse<O>;

type HasUndefined<T> = undefined extends T ? true : false;

const RESTRICTED_DATA_FIELDS = {
  header: ["cookie"],
};

export const validate = <
  T extends Type,
  Target extends keyof ValidationTargets,
  E extends Env,
  P extends string,
  I = T["inferIn"],
  O = T["infer"],
  V extends {
    in: HasUndefined<I> extends true ? { [K in Target]?: I } : { [K in Target]: I };
    out: { [K in Target]: O };
  } = {
    in: HasUndefined<I> extends true ? { [K in Target]?: I } : { [K in Target]: I };
    out: { [K in Target]: O };
  },
>(
  target: Target,
  schema: T,
  hook?: Hook<T["infer"], E, P>,
): MiddlewareHandler<E, P, V> =>
  // @ts-expect-error not typed well
  validator(target, (value, c) => {
    const out = schema(value);

    const hasErrors = out instanceof type.errors;

    if (hook) {
      const hookResult = hook(
        hasErrors ? { success: false, data: value, errors: out } : { success: true, data: out },
        c,
      );
      if (hookResult) {
        if (hookResult instanceof Response || hookResult instanceof Promise) {
          return hookResult;
        }
        if ("response" in hookResult) {
          return hookResult.response;
        }
      }
    }

    if (hasErrors) {
      const errors =
        target in RESTRICTED_DATA_FIELDS
          ? out.map((error) => {
              const restrictedFields = RESTRICTED_DATA_FIELDS[target as keyof typeof RESTRICTED_DATA_FIELDS] || [];

              if (
                error &&
                typeof error === "object" &&
                "data" in error &&
                typeof error.data === "object" &&
                error.data !== null &&
                !Array.isArray(error.data)
              ) {
                const dataCopy = { ...(error.data as Record<string, unknown>) };
                for (const field of restrictedFields) {
                  delete dataCopy[field];
                }

                error.data = dataCopy;
              }

              return error;
            })
          : out;

      throw new AppError("Validation", errors.map((err) => err.toString()).join("\n"));
    }

    return out;
  });

export function validateOrThrow<T extends Type>(schema: T, value: unknown): T["infer"] {
  const out = schema(value);

  const hasErrors = out instanceof type.errors;
  if (!hasErrors) {
    return out;
  }

  throw new AppError("Validation", out.map((err) => err.toString()).join("\n"));
}

const MAX_INDEXED_FIELD = 20;

function transformIndexedFields(data: Record<string, unknown>, prefixes: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(data)) {
    result[key] = value;
  }

  for (const prefix of prefixes) {
    const record: Record<number, unknown> = {};
    const pattern = new RegExp(`^${prefix}\\[(\\d+)\\]$`);

    for (const key of Object.keys(result)) {
      const match = key.match(pattern);
      if (!match) continue;

      const index = Number.parseInt(match[1], 10);
      if (index > MAX_INDEXED_FIELD) continue;

      record[index] = result[key];
      delete result[key];
    }

    // Backward compat: plain field becomes index 0
    if (prefix in result && !(0 in record)) {
      record[0] = result[prefix];
      delete result[prefix];
    }

    if (Object.keys(record).length > 0) {
      result[prefix] = record;
    }
  }

  return result;
}

export const validateIndexedForm = <
  T extends Type,
  E extends Env,
  P extends string,
  I = T["inferIn"],
  O = T["infer"],
  V extends {
    in: HasUndefined<I> extends true ? { form?: I } : { form: I };
    out: { form: O };
  } = {
    in: HasUndefined<I> extends true ? { form?: I } : { form: I };
    out: { form: O };
  },
>(
  schema: T,
  prefixes: string[],
  hook?: Hook<T["infer"], E, P>,
): MiddlewareHandler<E, P, V> =>
  // @ts-expect-error not typed well
  validator("form", (value, c) => {
    const transformed = transformIndexedFields(value as Record<string, unknown>, prefixes);
    const out = schema(transformed);
    const hasErrors = out instanceof type.errors;

    if (hook) {
      const hookResult = hook(
        hasErrors ? { success: false, data: transformed, errors: out } : { success: true, data: out },
        c,
      );
      if (hookResult) {
        if (hookResult instanceof Response || hookResult instanceof Promise) {
          return hookResult;
        }
        if ("response" in hookResult) {
          return hookResult.response;
        }
      }
    }

    if (hasErrors) {
      throw new AppError("Validation", out.map((err) => err.toString()).join("\n"));
    }

    return out;
  });
