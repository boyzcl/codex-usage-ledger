// Every presentation of derived capacity carries the same unverified scope contract.
export const capacityLimitations=['Account identity and quota-window attribution are unverified.','Observed local usage may omit account usage; these are not official plan capacities.'];
export function capacityView<T extends Record<string,any>>(value:T,experimental=false){
 const out:Record<string,any>={...value,status:experimental?'experimental_unverified':'unverified',source:'local_capacity_derivation',strict_reason:value.strict_reason??value.reason??'unverified_account_window_attribution',limitations:capacityLimitations,experimental};
 if(!experimental){
  for(const key of ['estimated_capacity','lower_bound','upper_bound','estimated_tokens','estimated_api_known_usd','rounding_only_lower','rounding_only_upper'])if(key in out)out[key]=null;
  if('equivalents' in out)out.equivalents={};out.empirical=null;
  out.reason??='unverified_account_window_attribution';out.confidence='UNVERIFIED';
 }
 return out as T&{status:string;source:string;strict_reason:string;limitations:string[];experimental:boolean};
}
