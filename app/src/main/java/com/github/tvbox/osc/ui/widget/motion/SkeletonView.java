package com.github.tvbox.osc.ui.widget.motion;

import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.LinearGradient;
import android.graphics.Matrix;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.graphics.Shader;
import android.util.AttributeSet;
import android.view.View;
import android.view.animation.LinearInterpolator;

/**
 * 等高骨架屏：加载态按真实海报卡比例（214:280）铺排占位块，
 * 高度随列数与屏幕尺寸自适应，内容到达时不会出现「空白后突然撑开」的跳动。
 * 带一条缓慢横扫的高光（shimmer），用自绘实现，无第三方依赖。
 *
 * 注意：全部颜色写死、不调用 getResources()，避免触碰 AutoSize 回调链。
 */
public class SkeletonView extends View {

    private static final int CARD = Color.parseColor("#242B57");   // pw_card_soft
    private static final int CARD_DIM = Color.parseColor("#1B2148"); // pw_card
    private static final float CARD_RATIO = 280f / 214f;

    private final Paint cardPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint shimmerPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Path cardPath = new Path();
    private final RectF rect = new RectF();
    private final Matrix shaderMatrix = new Matrix();
    private LinearGradient shimmer;
    private ValueAnimator animator;
    private float phase = 0f;

    public SkeletonView(Context context) {
        super(context);
        init();
    }

    public SkeletonView(Context context, AttributeSet attrs) {
        super(context, attrs);
        init();
    }

    public SkeletonView(Context context, AttributeSet attrs, int defStyleAttr) {
        super(context, attrs, defStyleAttr);
        init();
    }

    private void init() {
        cardPaint.setColor(CARD);
        shimmerPaint.setStyle(Paint.Style.FILL);
        setWillNotDraw(false);
    }

    @Override
    protected void onSizeChanged(int w, int h, int oldw, int oldh) {
        super.onSizeChanged(w, h, oldw, oldh);
        if (w > 0) {
            float band = w * 0.45f;
            shimmer = new LinearGradient(
                    0f, 0f, band, 0f,
                    new int[]{Color.TRANSPARENT, Color.argb(46, 234, 240, 255), Color.TRANSPARENT},
                    new float[]{0f, 0.5f, 1f},
                    Shader.TileMode.CLAMP);
            shimmerPaint.setShader(shimmer);
        }
        startShimmer();
    }

    private void startShimmer() {
        if (animator != null) return;
        animator = ValueAnimator.ofFloat(0f, 1f);
        animator.setDuration(1500);
        animator.setRepeatCount(ValueAnimator.INFINITE);
        animator.setInterpolator(new LinearInterpolator());
        animator.addUpdateListener(new ValueAnimator.AnimatorUpdateListener() {
            @Override
            public void onAnimationUpdate(ValueAnimator animation) {
                phase = (Float) animation.getAnimatedValue();
                invalidate();
            }
        });
        animator.start();
    }

    @Override
    protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        int w = getWidth();
        int h = getHeight();
        if (w <= 0 || h <= 0) return;

        int shortSide = Math.min(w, h);
        boolean portrait = h > w;
        int span = portrait ? 2 : 5;
        float pad = shortSide * 0.025f;
        float gap = shortSide * 0.030f;
        float cell = (w - pad * 2f) / span - gap;
        if (cell <= 0f) return;
        float cardH = cell * CARD_RATIO;
        float radius = cell * 0.06f;

        float band = w * 0.45f;
        float scanX = phase * (w + band * 2f) - band;
        shaderMatrix.setTranslate(scanX - band / 2f, 0f);
        if (shimmer != null) shimmer.setLocalMatrix(shaderMatrix);

        float y = pad;
        int row = 0;
        while (y < h - pad * 0.5f && row < 30) {
            for (int col = 0; col < span; col++) {
                float x = pad + col * (cell + gap);
                if (x + cell > w - pad * 0.3f) continue;
                rect.set(x, y, x + cell, y + cardH);
                cardPath.reset();
                cardPath.addRoundRect(rect, radius, radius, Path.Direction.CW);

                canvas.save();
                canvas.clipPath(cardPath);
                // 相邻行交替深浅，增强层次
                cardPaint.setColor((row % 2 == 0) ? CARD : CARD_DIM);
                canvas.drawRect(rect, cardPaint);
                if (MotionConfig.SKELETON && shimmer != null) {
                    canvas.drawRect(0f, 0f, w, h, shimmerPaint);
                }
                canvas.restore();
            }
            y += cardH + gap;
            row++;
        }
    }

    @Override
    protected void onDetachedFromWindow() {
        super.onDetachedFromWindow();
        if (animator != null) {
            animator.cancel();
            animator = null;
        }
        shimmer = null;
        shimmerPaint.setShader(null);
    }
}
