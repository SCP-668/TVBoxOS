package com.github.tvbox.osc.ui.widget.motion;

import android.animation.TimeInterpolator;

/**
 * 阻尼过冲插值器：松手后先冲过目标一点点，再带阻尼回稳到原始尺寸。
 * 对比系统 BounceInterpolator（多次弹跳、显得廉价），这条曲线只有一次过冲，
 * 更接近「按压回弹」视频里演示的手感。
 *
 * 注意：纯数学实现，内部不访问 Resources，绝不触碰 AutoSize 回调链。
 */
public class DampedOvershootInterpolator implements TimeInterpolator {

    private final float decay;
    private final float frequency;
    private final float endValue;

    public DampedOvershootInterpolator() {
        this(6.0f, 9.0f);
    }

    public DampedOvershootInterpolator(float decay, float frequency) {
        this.decay = decay;
        this.frequency = frequency;
        // 归一化，保证 t=1 时精确返回 1
        this.endValue = 1.0f - (float) (Math.exp(-decay) * Math.cos(frequency));
    }

    @Override
    public float getInterpolation(float t) {
        if (t <= 0f) return 0f;
        if (t >= 1f) return 1f;
        float value = 1.0f - (float) (Math.exp(-decay * t) * Math.cos(frequency * t));
        return value / endValue;
    }
}
