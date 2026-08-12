/**
 * OpenAI-shaped error bodies.
 *
 * Real endpoints answer failures with `{ "error": { message, type, param, code } }`
 * and a meaningful HTTP status. Vela's provider layer has to key off `code` and
 * status, never off prose, so the harness is strict about emitting both.
 */

export interface OpenAiErrorBody {
  readonly error: {
    readonly message: string;
    readonly type: string;
    readonly param: string | null;
    readonly code: string | null;
  };
}

/** The error codes this harness emits. Consumers may switch on these. */
export const ERROR_CODES = {
  /** Prompt (+ requested completion) does not fit the profile's context window. */
  contextLengthExceeded: 'context_length_exceeded',
  /** An `image_url` part reached a profile with `vision: false`. */
  visionNotSupported: 'vision_not_supported',
  /** `tools` reached a profile with `toolCalling: 'none'` that rejects them. */
  toolsNotSupported: 'tools_not_supported',
  /** `response_format` reached a profile configured to reject it. */
  responseFormatNotSupported: 'response_format_not_supported',
  /** The requested model id is not the one this endpoint serves. */
  modelNotFound: 'model_not_found',
  /** `modelListing: false` — the endpoint cannot enumerate models. */
  modelListingNotSupported: 'model_listing_not_supported',
  invalidApiKey: 'invalid_api_key',
  /**
   * An `Authorization` header that is present but carries nothing. Vela must
   * send NO header when there is no credential, rather than an empty bearer;
   * this code makes that mistake loud instead of silent.
   */
  emptyAuthorizationHeader: 'empty_authorization_header',
  invalidJson: 'invalid_json',
  missingField: 'missing_required_parameter',
  unknownRoute: 'unknown_url',
  methodNotAllowed: 'method_not_allowed',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export interface MockErrorInit {
  readonly status: number;
  readonly message: string;
  readonly code: ErrorCode;
  readonly type?: string;
  readonly param?: string | null;
}

/** Thrown by handlers; the server turns it into a status + JSON body. */
export class MockHttpError extends Error {
  readonly status: number;
  readonly body: OpenAiErrorBody;

  constructor(init: MockErrorInit) {
    super(init.message);
    this.name = 'MockHttpError';
    this.status = init.status;
    this.body = {
      error: {
        message: init.message,
        type: init.type ?? 'invalid_request_error',
        param: init.param ?? null,
        code: init.code,
      },
    };
  }
}
