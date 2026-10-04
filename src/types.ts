export const tokenFields = ['input_tokens','cached_input_tokens','cache_write_input_tokens','output_tokens','reasoning_output_tokens','total_tokens'] as const;
export type TokenField = typeof tokenFields[number];
export type Tokens = Record<TokenField, number>;
export interface Usage extends Tokens {
 repair_status?:'source_unavailable';fork_ordinal_exclusive?:number|null;
 id:string; response_id:string|null; session_id:string; thread_id:string; turn_id:string|null; root_turn_id:string|null;
 timestamp:string; model:string; reasoning_effort:string|null; service_tier:string; project:string|null;
 uncached_input_tokens:number; source:string; model_source:string; attribution_quality:string; data_quality:string;
 inherited:boolean; parent_thread_id:string|null; fingerprint:string|null; ordinal:number|null;
 api_equivalent_usd:number|null; credit_equivalent:number|null; allowance_weight:number|null;
 api_rule_id:string|null; credit_rule_id:string|null; allowance_rule_id:string|null;
}
export interface Quota {
 id:string; timestamp:string; limit_id:string; slot:string; window_duration_mins:number|null;
 resets_at:number|null; used_percent:number; source:string; raw_json:string;
}
export interface Context {model:string; model_source:string; service_tier:string; reasoning_effort:string|null; project:string|null;}
export interface ParseState extends Context {
 thread_id:string; session_id:string; parent_thread_id:string|null; created_at:string|null;
 fork_ordinal_exclusive:number|null;turn_id:string|null; root_turn_id:string|null; previous:Tokens|null; exact_turns:string[];
 contexts:Record<string,Context>; legacy_index:number; has_exact:boolean; replay_done:boolean; replay_next_index:number|null;
}
export interface ParseOutput {usage:Usage[]; quotas:Quota[]; issues:{code:string; timestamp:string|null}[]; exactTurn?:{thread:string;turn:string};}
export type Rates={input:number;cached_input:number;cache_write:number|null;output:number};
export interface PriceRule {
 id:string; kind:'api'|'credit'|'allowance'; model:string; processing_mode:string;
 effective_from:string; effective_to:string|null; context_min:number;context_max:number|null;
 rates:Rates;source_url:string;retrieved_at:string;basis:string;
}
export interface Config {
 codex_home:string; timezone:string; poll_seconds:number; codex_binary:string;
 monitor?:{local_reconcile_seconds:number;quota_active_seconds:number;quota_idle_seconds:number;activity_seconds:number;summary_seconds:number;debounce_ms:number};
 estimator:{weight_basis:'verified'|'credit_proxy';bucket_models:Record<string,string[]>};
}
