import { type } from "arktype";
import { HTTPException } from "hono/http-exception";
import type { StatusCode } from "hono/utils/http-status";

export const AppErrors = {
  Other: ["unknown", 500],
  Invalid: ["invalid-request", 400],
  Authn: ["authentication", 401],
  Authz: ["authorization", 403],
  NotExist: ["resource-not-found", 404],
  Exist: ["resource-already-exists", 409],
  Validation: ["validation", 422],
  Captcha: ["captcha", 422],
  RateLimiting: ["rate-limiting", 429],
  Database: ["database-query", 500],
  Service: ["internal-service-failure", 500],
} as const;

const schemaAppError = type({
  code: type.enumerated(...(Object.keys(AppErrors) as Array<keyof typeof AppErrors>)),
  cause: "string",
});

export const schemaAppErrorJSON = type("string.json.parse").to(schemaAppError);

export class AppError extends Error {
  code: keyof typeof AppErrors;
  httpCode: StatusCode;
  constructor(code: keyof typeof AppErrors, message: string) {
    super(code, {
      cause: message,
    });
    this.code = code;
    const httpCode = AppErrors[code][1];
    if (!httpCode) {
      console.debug("app:error", code, message);
    }

    this.httpCode = httpCode || 500;
  }

  toString() {
    return `${this.code} - ${this.cause}`;
  }

  toInternalJSON() {
    return JSON.stringify({
      code: this.code,
      message: this.message,
      cause: this.cause,
      httpCode: this.httpCode,
    });
  }

  toPrimitiveError() {
    return new Error(`AppError:${this.toInternalJSON()}`);
  }

  static fromPrimitiveError(err: Error) {
    const parts = err.message.split("AppError:");
    if (parts.length !== 2) {
      return;
    }

    return AppError.fromInternalJSON(parts[1]);
  }

  static fromInternalJSON(json: string | null | undefined) {
    if (!json) {
      return;
    }

    const out = schemaAppErrorJSON(json);
    if (out instanceof type.errors) {
      return;
    }

    const error = new AppError(out.code, out.cause);
    return error;
  }

  static fromInternalObject(obj: object) {
    if (!obj) {
      return;
    }

    const out = schemaAppError(obj);
    if (out instanceof type.errors) {
      throw out;
    }

    const error = new AppError(out.code, out.cause);
    return error;
  }
}

export function wrapError(err: Error): AppError {
  if (err instanceof AppError) {
    return err;
  }

  if (err.message.includes("D1_ERROR: UNIQUE constraint failed")) {
    return new AppError("Exist", "Already exist");
  }

  if (err.message.includes("D1_ERROR") || err.name === "PostgresError") {
    return new AppError("Database", err.message);
  }

  // if (err instanceof NoResultError) {
  //   // From Kysely
  //   return new AppError("NotExist", err.message);
  // }

  if ("code" in err && "routine" in err && "severity" in err) {
    // From pg
    return new AppError("Database", err.message);
  }

  if (err.name === "TimeoutError") {
    return new AppError("Invalid", "Aborted due to timeout");
  }

  if (err instanceof HTTPException) {
    // From jwt middleware
    if (err.status === 401) {
      return new AppError("Authn", err.message);
    }
  }

  return new AppError("Other", err.message);
}

export function appErrorToBody(errApp: AppError) {
  if (errApp.code === "Database" || errApp.code === "Service" || errApp.code === "Other") {
    return {
      code: AppErrors[errApp.code][0],
      message: errApp.message,
    };
  }

  return {
    code: AppErrors[errApp.code][0],
    message: errApp.cause,
  };
}
