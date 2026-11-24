package com.github.tvbox.osc.ui.widget.motion;

import android.view.MotionEvent;
import android.view.View;

/**
 * 按压回弹：按下时轻微缩小，松手后带阻尼过冲回到目标缩放比。
 * 用于卡片焦点态（选中放大）与点击态，取代系统 BounceInterpolator 的多段弹跳。
 *
 * 注意：本类只操作 View 的 scale 属性，不读取任何资源、不触发 AutoSize 回调链。
 */
public final class PressRebound {

    private static final DampedOvershootInterpolator SPRING = new DampedOvershootInterpolator();
    private static final float SCALE_DOWN = 0.94f;

    private PressRebound() {
    }

    /** 焦点选中：放大到 focusScale；取消焦点：回到 1.0，均走阻尼过冲。 */
    public static void focus(View view, boolean selected, float focusScale) {
        if (view == null || !MotionConfig.PRESS_REBOUND) return;
        float target = selected ? focusScale : 1.0f;
        view.animate().cancel();
        view.animate().scaleX(target).scaleY(target)
                .setDuration(240)
                .setInterpolator(SPRING)
                .start();
    }

    /**
     * 给普通可点击控件（Tab、胶囊、按钮）绑定「按压回弹 + 跟手波纹」。
     * 两者共用一个 OnTouchListener，避免相互覆盖；返回 false 保证不吞掉 onClick。
     */
    public static void bind(final View view) {
        if (view == null) return;
        final boolean doPress = MotionConfig.PRESS_REBOUND;
        final boolean doRipple = MotionConfig.TOUCH_RIPPLE;
        if (!doPress && !doRipple) return;
        view.setOnTouchListener(new View.OnTouchListener() {
            @Override
            public boolean onTouch(View v, MotionEvent event) {
                switch (event.getAction()) {
                    case MotionEvent.ACTION_DOWN:
                        if (doPress) {
                            v.animate().cancel();
                            v.animate().scaleX(SCALE_DOWN).scaleY(SCALE_DOWN)
                                    .setDuration(90).start();
                        }
                        if (doRipple) {
                            TouchRipple.spawn(v, event.getX(), event.getY());
                        }
                        return false;
                    case MotionEvent.ACTION_UP:
                    case MotionEvent.ACTION_CANCEL:
                        if (doPress) {
                            v.animate().cancel();
                            v.animate().scaleX(1.0f).scaleY(1.0f)
                                    .setDuration(260).setInterpolator(SPRING).start();
                        }
                        return false;
                    default:
                        return false;
                }
            }
        });
    }
}
