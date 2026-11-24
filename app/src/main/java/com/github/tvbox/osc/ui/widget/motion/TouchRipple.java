package com.github.tvbox.osc.ui.widget.motion;

import android.animation.ValueAnimator;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.ColorFilter;
import android.graphics.Paint;
import android.graphics.PixelFormat;
import android.graphics.drawable.Drawable;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewOverlay;
import android.view.animation.DecelerateInterpolator;

/**
 * 跟手波纹：以真实触点为圆心向外扩散，松手渐隐。
 * 用 ViewOverlay 叠加绘制，不改动控件原有 background/selector，
 * 因此不影响 TV 焦点态。内部不使用 Resources，不触发 AutoSize 回调链。
 */
public final class TouchRipple {

    private TouchRipple() {
    }

    public static void bind(final View view) {
        if (view == null || !MotionConfig.TOUCH_RIPPLE) return;
        view.setOnTouchListener(new View.OnTouchListener() {
            @Override
            public boolean onTouch(View v, MotionEvent event) {
                int action = event.getActionMasked();
                if (action == MotionEvent.ACTION_DOWN) {
                    spawn(v, event.getX(), event.getY());
                }
                return false; // 不吞事件，onClick / TV 焦点逻辑照常
            }
        });
    }

    static void spawn(View view, float x, float y) {
        int w = view.getWidth();
        int h = view.getHeight();
        if (w <= 0 || h <= 0) return;
        float maxRadius = (float) Math.sqrt(w * w + h * h) * 0.55f + 8f;
        RippleDrawable rd = new RippleDrawable(x, y, maxRadius);
        try {
            ViewOverlay overlay = view.getOverlay();
            overlay.add(rd);
            ValueAnimator animator = ValueAnimator.ofFloat(0f, 1f);
            animator.setDuration(360);
            animator.setInterpolator(new DecelerateInterpolator());
            animator.addUpdateListener(new ValueAnimator.AnimatorUpdateListener() {
                @Override
                public void onAnimationUpdate(ValueAnimator animation) {
                    rd.setProgress((Float) animation.getAnimatedValue());
                    rd.invalidateSelf();
                }
            });
            animator.start();
        } catch (Throwable ignored) {
            // 极端机型 overlay 不可用时不崩，仅无波纹
        }
    }

    private static final class RippleDrawable extends Drawable {
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final float cx;
        private final float cy;
        private final float maxRadius;
        private float progress = 0f;

        RippleDrawable(float cx, float cy, float maxRadius) {
            this.cx = cx;
            this.cy = cy;
            this.maxRadius = maxRadius;
            paint.setColor(Color.argb(90, 34, 211, 238)); // pw_blue 半透明
            paint.setStyle(Paint.Style.FILL);
        }

        void setProgress(float p) {
            this.progress = p;
            paint.setAlpha((int) (90 * (1f - p)));
        }

        @Override
        public void draw(Canvas canvas) {
            canvas.save();
            canvas.clipRect(getBounds());
            canvas.drawCircle(cx, cy, maxRadius * progress, paint);
            canvas.restore();
        }

        @Override
        public void setAlpha(int alpha) {
        }

        @Override
        public void setColorFilter(ColorFilter colorFilter) {
        }

        @Override
        public int getOpacity() {
            return PixelFormat.TRANSLUCENT;
        }
    }
}
