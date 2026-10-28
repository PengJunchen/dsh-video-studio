"""Bounded, camera-independent tone proposals from display RGB16 samples.

Structure and residual measurements are image statistics, not sensor-noise or
semantic scene classifications. Proposals are optional and require acceptance.
"""
from __future__ import annotations

import array
import math
import statistics
import sys
from functools import lru_cache
from tone_lut import _tone_gain, TONE_ALGORITHM_VERSION, LOW_LIGHT_ALGORITHM_VERSION

BINS=4096


def _quantile(histogram, count, fraction):
    target=round((count-1)*fraction)
    total=0
    for index,value in enumerate(histogram):
        total+=value
        if total>target:
            return index/(BINS-1)
    raise ValueError('No sampled pixels')


def _percentile(values, fraction):
    ordered=sorted(values)
    return ordered[round((len(ordered)-1)*fraction)]


def _solve(luminance, target, field, bound):
    low,high=(0,bound) if field=='shadows' else (-bound,0)
    for _ in range(24):
        amount=(low+high)/2
        value=luminance*_tone_gain(luminance,amount if field=='shadows' else 0,
                                  amount if field=='highlights' else 0)
        if value<target:low=amount
        else:high=amount
    value=round((low+high)/2/.05)*.05
    return round(value,2) if abs(value)>=.025 else None


def _solve_low_light(luminance, shadows, target, bound=.85):
    """Invert the optional second toe after the existing v3 shadow proposal."""
    baseline=luminance*_tone_gain(luminance,shadows,0)
    if luminance<=0 or baseline>=target:
        return None
    low,high=0.0,bound
    for _ in range(24):
        amount=(low+high)/2
        value=luminance*_tone_gain(luminance,shadows,0,amount)
        if value<target:low=amount
        else:high=amount
    value=round((low+high)/2/.05)*.05
    return round(min(bound,value),2) if value>=.025 else None


def propose_tone(metrics, eligible=True):
    """Keep black/white clipping and low-information scenes distinct from keep."""
    if not eligible:
        return {'status':'ineligible','shadows':None,'highlights':None,'reason':'working_domain_unknown'}
    p02,p10,p50,p90,p98,p99=(metrics[key] for key in ('p02','p10','p50','p90','p98','p99'))
    span=p98-p02
    structure=metrics['block_span']
    residual=metrics['residual_proxy']
    clipped=metrics['black_fraction']>=.995 or metrics['white_fraction']>=.995
    useful=span>=.002 and structure>=.0005 and structure>=.6*residual
    if clipped or span<.0005:
        return {'status':'review','shadows':None,'highlights':None,
                'reason':'clipped_or_flat','summary':'抽样画面层次不足，需人工复核；暂不生成明暗数值。'}
    shadows=highlights=None
    reason='balanced'
    if p50<.14 and p90<.40:
        if useful and p50<=0:
            return {'status':'review','shadows':None,'highlights':None,
                    'reason':'black_median','summary':'抽样暗部接近纯黑，需人工确认可用层次；暂不自动提亮。'}
        if useful:
            max_lift=4 if structure>=1.5*residual else 2
            target=min(.16,max(.08,p50*2.5),p50*max_lift)
            if p50>0 and target>p50*1.1:
                shadows=_solve(p50,target,'shadows',.65)
                reason='dark_with_structure'
        else:
            return {'status':'review','shadows':None,'highlights':None,
                    'reason':'dark_detail_uncertain','summary':'抽样画面较暗，尚不能可靠区分层次与细碎波动；可先放大检查。'}
    elif useful and p10<.10 and p50>.18 and p10>0:
        shadows=_solve(p10,min(.10,p10*1.8),'shadows',.40)
        reason='deep_shadows'
    if useful and p90>.78 and p99>.94:
        highlights=_solve(p99,.90,'highlights',.55)
        reason='bright_rolloff' if shadows is None else 'mixed_contrast'
    return {'status':'suggested' if shadows is not None or highlights is not None else 'keep',
            'shadows':shadows,'highlights':highlights,'reason':reason,
            'predicted_median':round(p50*_tone_gain(p50,shadows or 0,highlights or 0),6),
            'predicted_p99':round(p99*_tone_gain(p99,shadows or 0,highlights or 0),6)}


def propose_low_light(metrics, tone_recommendation, eligible=True):
    """A separately opt-in candidate when the v3 proposal leaves a structured frame very dark."""
    if not eligible or tone_recommendation['reason']!='dark_with_structure':
        return None
    p50=metrics['p50']
    shadows=tone_recommendation['shadows']
    if p50<=0 or p50>=.05 or shadows is None:
        return None
    v3_median=p50*_tone_gain(p50,shadows,0)
    if v3_median>=.07:
        return None
    amount=_solve_low_light(p50,shadows,.08)
    if amount is None:
        return None
    return {'amount':amount,'baseline_median':round(p50,6),
            'reference_shadows_amount':shadows,
            'v3_median':round(v3_median,6),
            'predicted_median':round(p50*_tone_gain(p50,shadows,0,amount),6),
            'target_median':.08,
            'block_span':round(metrics['block_span'],6),
            'residual_proxy':round(metrics['residual_proxy'],6)}


def _frame_python(raw,width,height):
    count=width*height
    rgb=array.array('H',raw)
    if sys.byteorder!='little':rgb.byteswap()
    local_hues=[0.0]*24
    local_chromatic=0
    histogram=[0]*BINS
    luma=[]
    block_columns=(width+7)//8
    block_count=block_columns*((height+7)//8)
    sums=[0.0]*block_count
    sizes=[0]*block_count
    luma_sum=0
    for pixel in range(count):
        offset=pixel*3
        red,green,blue=rgb[offset],rgb[offset+1],rgb[offset+2]
        y=(.2126*red+.7152*green+.0722*blue)/65535
        code=max(0,min(BINS-1,round(y*(BINS-1))))
        histogram[code]+=1
        luma.append(y)
        luma_sum+=y
        block=(pixel//width//8)*block_columns+(pixel%width//8)
        sums[block]+=y;sizes[block]+=1
        chroma=(max(red,green,blue)-min(red,green,blue))/65535
        if chroma>=.12:
            local_chromatic+=1
            hue=math.degrees(math.atan2(math.sqrt(3)*(green-blue),2*red-green-blue))%360
            local_hues[min(23,int(hue/15))]+=chroma
    residuals=[abs(luma[row*width+col-1]-2*luma[row*width+col]+luma[row*width+col+1])
               for row in range(0,height,2) for col in range(1,width-1,2)]
    blocks=[total/size for total,size in zip(sums,sizes) if size]
    return {'histogram':histogram,'mean':luma_sum/count,
            'block_span':_percentile(blocks,.9)-_percentile(blocks,.1),
            'residual_proxy':statistics.median(residuals)/(.67448975*math.sqrt(6)) if residuals else 0,
            'hue_bins':local_hues,'chromatic_pixels':local_chromatic}

@lru_cache(maxsize=1)
def _numpy():
    try:
        import numpy
        return numpy
    except ImportError:
        return None


def _frame_numpy(raw,width,height,np):
    rgb=np.frombuffer(raw,dtype='<u2').reshape(height,width,3).astype(np.float64)
    luma=(.2126*rgb[:,:,0]+.7152*rgb[:,:,1]+.0722*rgb[:,:,2])/65535
    histogram=np.bincount(np.clip(np.rint(luma*(BINS-1)),0,BINS-1).astype(np.int32).ravel(),minlength=BINS).tolist()
    row_starts=np.arange(0,height,8);col_starts=np.arange(0,width,8)
    sums=np.add.reduceat(np.add.reduceat(luma,row_starts,axis=0),col_starts,axis=1)
    sizes=np.minimum(8,height-row_starts)[:,None]*np.minimum(8,width-col_starts)[None,:]
    blocks=(sums/sizes).ravel().tolist()
    residuals=np.abs(luma[::2,:-2:2]-2*luma[::2,1:-1:2]+luma[::2,2::2])
    chroma=(rgb.max(axis=2)-rgb.min(axis=2))/65535
    valid=chroma>=.12
    red,green,blue=(rgb[:,:,channel][valid] for channel in range(3))
    hue=np.mod(np.degrees(np.arctan2(math.sqrt(3)*(green-blue),2*red-green-blue)),360)
    hue_bins=np.bincount(np.minimum(23,(hue/15).astype(np.int32)),weights=chroma[valid],minlength=24).tolist()
    return {'histogram':histogram,'mean':float(luma.mean()),
            'block_span':_percentile(blocks,.9)-_percentile(blocks,.1),
            'residual_proxy':float(np.median(residuals))/(.67448975*math.sqrt(6)) if residuals.size else 0,
            'hue_bins':hue_bins,'chromatic_pixels':int(np.count_nonzero(valid))}


def summarize_rgb16(samples, width, height, *, eligible, accelerate=True):
    """One RGB pass: precise luma, color variety, structure, bounded residuals."""
    np=_numpy() if accelerate else None
    count=width*height
    global_hist=[0]*BINS
    hue_bins=[0.0]*24
    chromatic=0
    rows=[]
    for time_seconds,raw in samples:
        if len(raw)!=count*6:
            raise ValueError('RGB16 sample size differs from its dimensions')
        frame=_frame_numpy(raw,width,height,np) if np is not None else _frame_python(raw,width,height)
        histogram=frame['histogram']
        chromatic+=frame['chromatic_pixels']
        for index,value in enumerate(frame['hue_bins']):hue_bins[index]+=value
        values={key:_quantile(histogram,count,q) for key,q in
                (('p01',.01),('p02',.02),('p10',.1),('p50',.5),('p90',.9),('p98',.98),('p99',.99))}
        values.update({'block_span':frame['block_span'],
                       'residual_proxy':frame['residual_proxy'],
                       'black_fraction':histogram[0]/count,'white_fraction':histogram[-1]/count})
        recommendation=propose_tone(values,eligible)
        low_light_recommendation=propose_low_light(values,recommendation,eligible)
        rows.append({'time_seconds':time_seconds,'luma_mean':round(frame['mean']*255,3),
                     **{key:round(values[key]*255,4) for key in ('p10','p50','p90','p99')},
                     'dark_fraction':sum(histogram[:81])/count,
                     'near_white_fraction':sum(histogram[4015:])/count,
                     'precision':{key:round(value,8) for key,value in values.items()},
                     'tone_recommendation':recommendation,
                     'low_light_recommendation':low_light_recommendation})
        for index,value in enumerate(histogram):global_hist[index]+=value
    total=count*len(rows)
    if not total:raise ValueError('No sampled pixels')
    suggestions={}
    for field in ('shadows','highlights'):
        candidates=[row['tone_recommendation'][field] for row in rows if row['tone_recommendation'][field] is not None]
        suggestions[field]=round(statistics.median(candidates),2) if len(candidates)>=math.ceil(len(rows)*.8) else None
    low_light_rows=[row['low_light_recommendation'] for row in rows if row['low_light_recommendation'] is not None]
    low_light=({'amount':round(statistics.median(item['amount'] for item in low_light_rows),2),
                'predicted_median':round(statistics.median(item['predicted_median'] for item in low_light_rows),6),
                'reference_shadows_amount':round(statistics.median(item['reference_shadows_amount']
                                                                     for item in low_light_rows),2),
                'support_count':len(low_light_rows),'sample_count':len(rows),
                'algorithm_version':LOW_LIGHT_ALGORITHM_VERSION,
                'basis':'structured display-luma; optional proposal after the v3 shadow candidate',
                'limitation':'Reference sampling does not account for already accepted tone intervals or recover clipped detail.'}
               if len(low_light_rows)>=math.ceil(len(rows)*.8) else None)
    review=sum(row['tone_recommendation']['status']=='review' for row in rows)
    suggested=any(value is not None for value in suggestions.values())
    any_local=any(row['tone_recommendation']['status']=='suggested' for row in rows)
    status='ineligible' if not eligible else 'suggested' if suggested else 'segmented' if any_local else 'review' if review else 'keep'
    summary={'ineligible':'当前尚未得到标准显示色彩，暂不生成明暗建议。',
             'suggested':'抽样中发现可尝试改善的明暗层次；建议按画面分布计算，点击后才应用。',
             'segmented':'不同位置的明暗需求有变化，可先查看时间条提示，再按段采纳。',
             'review':'抽样画面较暗或层次依据不足，请放大复核；没有建议不代表无需调整。',
             'keep':'抽样明暗较均衡，可保留当前分布，再按个人风格微调。'}[status]
    return {'statistics_backend':'numpy' if np is not None else 'python','pixel_count':total,'percentiles':{key:round(_quantile(global_hist,total,q)*255,4) for key,q in
            (('p01',.01),('p10',.1),('p50',.5),('p90',.9),('p99',.99))},
            'dark_fraction':sum(global_hist[:81])/total,'near_white_fraction':sum(global_hist[4015:])/total,
            'frame_summaries':rows,'hue_bins':hue_bins,'chromatic_pixels':chromatic,
            'tone_advice':{'version':1,'status':status,'summary':summary,'suggestions':suggestions,
                           'low_light':low_light,
                           'confidence':'low' if eligible else 'unavailable','review_sample_count':review,
                           'sample_count':len(rows),'algorithm_version':TONE_ALGORITHM_VERSION,
                           'basis':'RGB16 display-luma; 4096-bin quantiles, block structure and residual proxy',
                           'limitation':'Sparse image statistics do not determine creative intent, real sensor noise, or recover clipped detail.'}}
