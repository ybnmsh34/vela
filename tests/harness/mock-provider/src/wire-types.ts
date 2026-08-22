/**
 * OpenAI-compatible wire shapes.
 *
 * NOTE ON NAMING: these are `snake_case` on purpose. This file describes a
 * *foreign* protocol — the one llama.cpp, Ollama, LM Studio, vLLM and the
 * hosted APIs all speak. Vela's own IPC contract is camelCase and lives in
 * `src/platform/contract.ts`; nothing here is part of it.
 *
 * The request types describe what a well-behaved client sends. They are not
 * trusted: `parse-request.ts` validates an `unknown` body against them and
 * rejects anything else with a 400, exactly as a real server would.
 */

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface TextContentPart {
  readonly type: 'text';
  readonly text: string;
}

export interface ImageContentPart {
  readonly type: 'image_url';
  readonly image_url: { readonly url: string; readonly detail?: string };
}

export type ContentPart = TextContentPart | ImageContentPart;

export interface ToolCallFunction {
  readonly name: string;
  /** Always a JSON *string* on the wire — even when the JSON inside is broken. */
  readonly arguments: string;
}

export interface ToolCall {
  readonly id: string;
  readonly type: 'function';
  readonly function: ToolCallFunction;
}

export interface ChatMessage {
  readonly role: ChatRole;
  readonly content: string | readonly ContentPart[] | null;
  readonly tool_calls?: readonly ToolCall[];
  readonly tool_call_id?: string;
  readonly name?: string;
}

/** A permissive JSON-Schema subset — enough to synthesise conforming values. */
export interface JsonSchemaNode {
  readonly type?: string;
  readonly properties?: Readonly<Record<string, JsonSchemaNode>>;
  readonly items?: JsonSchemaNode;
  readonly enum?: readonly unknown[];
  readonly required?: readonly string[];
  readonly description?: string;
}

export interface ToolDefinition {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description?: string;
    readonly parameters?: JsonSchemaNode;
  };
}

export type ToolChoice =
  | 'none'
  | 'auto'
  | 'required'
  | { readonly type: 'function'; readonly function: { readonly name: string } };

export type ResponseFormat =
  | { readonly type: 'text' }
  | { readonly type: 'json_object' }
  | {
      readonly type: 'json_schema';
      readonly json_schema: {
        readonly name: string;
        readonly schema: JsonSchemaNode;
        readonly strict?: boolean;
      };
    };

export interface Usage {
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
  readonly total_tokens: number;
}

export type FinishReason = 'stop' | 'length' | 'tool_calls';

export interface ChatCompletionChoice {
  readonly index: number;
  readonly message: {
    readonly role: 'assistant';
    readonly content: string | null;
    /** Present only on profiles whose reasoning transport is a separate field. */
    readonly reasoning_content?: string;
    readonly tool_calls?: readonly unknown[];
  };
  readonly finish_reason: FinishReason;
}

export interface ChatCompletionResponse {
  readonly id: string;
  readonly object: 'chat.completion';
  readonly created: number;
  readonly model: string;
  readonly choices: readonly ChatCompletionChoice[];
  readonly usage: Usage;
}

export interface ModelListResponse {
  readonly object: 'list';
  readonly data: readonly {
    readonly id: string;
    readonly object: 'model';
    readonly created: number;
    readonly owned_by: string;
  }[];
}
