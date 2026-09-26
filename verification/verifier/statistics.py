"""Paired comparisons with task-cluster resampling and conservative quality bounds."""
from __future__ import annotations
import math, random, statistics


def wilson(success: int, n: int, z: float=1.96) -> tuple[float,float]:
    if n<=0:return 0.,1.
    p=success/n;d=1+z*z/n;mid=(p+z*z/(2*n))/d
    half=z*math.sqrt(p*(1-p)/n+z*z/(4*n*n))/d
    return max(0.,mid-half),min(1.,mid+half)


def quantile(values,p):
    values=sorted(values); x=(len(values)-1)*p;lo=int(x);hi=min(lo+1,len(values)-1)
    return values[lo]*(1-(x-lo))+values[hi]*(x-lo)


def compare(rows: list[dict], runtime: str, baseline: str, *, seed=1701, min_tasks=8,
            quality_margin=.05, min_speed_gain=.05, family_size=1) -> dict:
    table={};duplicates=[]
    for r in rows:
        if r.get('runtime')!=runtime or r.get('arm') not in (baseline,'active'):continue
        k=(r['task_id'],r['repeat'])
        if r['arm'] in table.setdefault(k,{}):duplicates.append((k,r['arm']))
        table[k][r['arm']]=r
    pairs=[(k,d[baseline],d['active']) for k,d in table.items() if set(d)=={baseline,'active'}]
    result={'runtime':runtime,'baseline':baseline,'candidate':'active','paired_runs':len(pairs),
            'scope':'This fixed task suite only; not all coding workloads','verdict':'INCONCLUSIVE'}
    if duplicates:return result|{'reason':'DUPLICATE_TASK_REPEAT_ARM','duplicates':duplicates}
    if any(set(d)!={baseline,'active'} for d in table.values()):return result|{'reason':'INCOMPLETE_PAIRED_COHORT'}
    for _,a,b in pairs:
        for row in (a,b):
            duration=row.get('duration_ms')
            if isinstance(duration,bool) or not isinstance(duration,(int,float)) or not math.isfinite(duration) or duration<=0:
                return result|{'reason':'INVALID_DURATION'}
            if type(row.get('passed')) is not bool:return result|{'reason':'INVALID_PASS_OBSERVATION'}
            cost=row.get('total_cost_usd')
            if cost is not None and (isinstance(cost,bool) or not isinstance(cost,(int,float)) or not math.isfinite(cost) or cost<0):
                return result|{'reason':'INVALID_COST'}
    if not pairs:return result|{'reason':'NO_PAIRED_LIVE_RUNS'}
    if any(a.get('evidence_source')!='REAL_NATIVE_PROCESS' or b.get('evidence_source')!='REAL_NATIVE_PROCESS' for _,a,b in pairs):
        return result|{'reason':'NON_LIVE_EVIDENCE'}
    if any(a.get('contaminated') or b.get('contaminated') for _,a,b in pairs):return result|{'reason':'INTEGRITY_OR_CONFIGURATION_CHANGED'}
    clusters={}
    for (task,_),a,b in pairs:clusters.setdefault(task,[]).append((a,b))
    # Repeats do not turn one task into many independent quality samples.
    n=len(clusters);base_ok=sum(all(x['passed'] for x,y in cs) for cs in clusters.values());cand_ok=sum(all(y['passed'] for x,y in cs) for cs in clusters.values())
    result.update(unique_tasks=n,quality={'baseline_all_repeats_passed_tasks':base_ok,'active_all_repeats_passed_tasks':cand_ok,
        'baseline_wilson':wilson(base_ok,n),'active_wilson':wilson(cand_ok,n),'margin':quality_margin})
    result['new_failures']=[task for task,cs in clusters.items() if any(x['passed'] and not y['passed'] for x,y in cs)]
    if result['new_failures']:return result|{'verdict':'REGRESSION_OBSERVED','reason':'BASELINE_PASS_ACTIVE_FAIL'}
    # All failed/timeout attempts are retained; paired workload cost is not success-only sampling.
    ratios=[]
    for task,cs in clusters.items():
        ratios.append(statistics.mean(math.log(max(y['duration_ms'],.01)/max(x['duration_ms'],.01)) for x,y in cs))
    result['latency_ratio_active_over_baseline']=math.exp(statistics.mean(ratios))
    rng=random.Random(seed);boot=[]
    for _ in range(4000):boot.append(math.exp(statistics.mean(rng.choices(ratios,k=n))))
    alpha=.05/max(1,family_size)
    interval=[quantile(boot,alpha/2),quantile(boot,1-alpha/2)]
    result['latency_cluster_bootstrap_interval']=interval
    result['interval_family_size']=family_size
    result['cost_verdict']='INCONCLUSIVE_MISSING_TOTAL_COST'
    if all(a.get('total_cost_usd') is not None and b.get('total_cost_usd') is not None for _,a,b in pairs):
        result['total_cost_ratio']=sum(b['total_cost_usd'] for _,a,b in pairs)/max(1e-12,sum(a['total_cost_usd'] for _,a,b in pairs))
        result['cost_verdict']='DESCRIPTIVE_ONLY'
    if n<min_tasks:return result|{'reason':'TOO_FEW_UNIQUE_TASKS'}
    if any(b.get('active_route_observed') is not True for _,_,b in pairs):return result|{'reason':'ACTIVE_TREATMENT_NOT_OBSERVED_IN_EVERY_RUN'}
    if any(b.get('model_effort_observed') is not True for _,_,b in pairs):return result|{'reason':'MODEL_EFFORT_APPLICATION_NOT_OBSERVED'}
    if baseline=='ultracode' and any(a.get('ultracode_observed') is not True for _,a,_ in pairs):
        return result|{'reason':'ULTRACODE_REQUESTED_BUT_NOT_OBSERVED'}
    # A degenerate bootstrap on all successes is not treated as proof of non-inferiority.
    if wilson(cand_ok,n)[0]-wilson(base_ok,n)[1]<-quality_margin:
        return result|{'reason':'QUALITY_NONINFERIORITY_NOT_ESTABLISHED'}
    if interval[1] >= 1-min_speed_gain:return result|{'reason':'LATENCY_GAIN_NOT_ESTABLISHED'}
    return result|{'verdict':'LATENCY_IMPROVEMENT_ON_THIS_SUITE','reason':'QUALITY_GUARD_AND_PAIRED_LATENCY_PASSED',
                  'overall_efficiency_superiority':False}
