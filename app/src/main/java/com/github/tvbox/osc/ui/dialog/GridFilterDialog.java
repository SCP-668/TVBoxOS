package com.github.tvbox.osc.ui.dialog;

import android.animation.ValueAnimator;
import android.content.Context;
import android.content.DialogInterface;
import android.util.DisplayMetrics;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.LayoutInflater;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.annotation.NonNull;

import com.chad.library.adapter.base.BaseQuickAdapter;
import com.github.tvbox.osc.R;
import com.github.tvbox.osc.bean.MovieSort;
import com.github.tvbox.osc.ui.adapter.GridFilterKVAdapter;
import com.github.tvbox.osc.ui.widget.motion.MotionConfig;
import com.github.tvbox.osc.ui.widget.motion.PressRebound;
import com.owen.tvrecyclerview.widget.TvRecyclerView;
import com.owen.tvrecyclerview.widget.V7LinearLayoutManager;

import org.jetbrains.annotations.NotNull;

import java.util.ArrayList;

public class GridFilterDialog extends BaseDialog {
    public LinearLayout filterRoot;

    private static final float HALF_RATIO = 0.55f;   // 半屏档
    private static final float FULL_RATIO = 0.88f;   // 全屏档
    private static final int SWIPE_SLOP = 60;        // 上拉/下拉切换阈值(px)

    private int halfHeightPx = 0;
    private int fullHeightPx = 0;
    private boolean expanded = false;
    private ValueAnimator heightAnimator;

    public GridFilterDialog(@NonNull @NotNull Context context) {
        super(context);
        setCanceledOnTouchOutside(false);
        setCancelable(true);
        setContentView(R.layout.dialog_grid_filter);
        filterRoot = findViewById(R.id.filterRoot);

        // 显式关闭出口：点击"关闭筛选"直接 dismiss（TV 遥控器/鼠标均可达）
        View closeBtn = findViewById(R.id.tvCloseFilter);
        if (closeBtn != null) {
            closeBtn.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    dismiss();
                }
            });
            PressRebound.bind(closeBtn);
        }
        // Dialog Context 未经 AutoSize density 适配，XML 里的 mm 字号被压小；用 px 覆盖
        applyDialogTextSize();

        // 分段式抽屉：手柄点击 / 上下滑动在半屏与全屏之间切换
        bindDrawerHandle();
        bindOutsideTouchDismiss();
    }

    /**
     * 按屏幕短边计算筛选弹窗字号(px)。Dialog 不走 BaseActivity 的 AutoSize 适配，
     * mm 单位在此被压小，改用 px 直接设置，横竖屏都清晰。
     */
    public static int filterTextPx(Context context) {
        DisplayMetrics dm = new DisplayMetrics();
        WindowManager wm = (WindowManager) context.getSystemService(Context.WINDOW_SERVICE);
        if (wm != null) {
            wm.getDefaultDisplay().getMetrics(dm);
        }
        int shortSide = Math.min(dm.widthPixels, dm.heightPixels);
        if (shortSide <= 0) shortSide = 720;
        return Math.max(18, Math.round(shortSide * 0.030f));
    }

    private void applyDialogTextSize() {
        int labelPx = filterTextPx(getContext());
        TextView handle = findViewById(R.id.tvFilterHandle);
        if (handle != null) {
            handle.setTextSize(TypedValue.COMPLEX_UNIT_PX, Math.max(16, labelPx - 2));
        }
        TextView close = findViewById(R.id.tvCloseFilter);
        if (close != null) {
            close.setTextSize(TypedValue.COMPLEX_UNIT_PX, labelPx);
        }
    }

    public interface Callback {
        void change();
    }

    public void setOnDismiss(Callback callback) {
        setOnDismissListener(new DialogInterface.OnDismissListener() {
            @Override
            public void onDismiss(DialogInterface dialogInterface) {
                if (selectChange) {
                    callback.change();
                }
            }
        });
    }

    public void setData(MovieSort.SortData sortData) {
        ArrayList<MovieSort.SortFilter> filters = sortData.filters;
        ViewGroup items = findViewById(R.id.filterItems);
        if (items == null) items = filterRoot;
        int textPx = filterTextPx(getContext());
        for (MovieSort.SortFilter filter : filters) {
            View line = LayoutInflater.from(getContext()).inflate(R.layout.item_grid_filter, null);
            TextView nameTv = line.findViewById(R.id.filterName);
            nameTv.setText(filter.name);
            nameTv.setTextSize(TypedValue.COMPLEX_UNIT_PX, textPx);
            TvRecyclerView gridView = line.findViewById(R.id.mFilterKv);
            gridView.setHasFixedSize(true);
            gridView.setLayoutManager(new V7LinearLayoutManager(getContext(), 0, false));
            GridFilterKVAdapter filterKVAdapter = new GridFilterKVAdapter(textPx);
            gridView.setAdapter(filterKVAdapter);
            String key = filter.key;
            ArrayList<String> values = new ArrayList<>(filter.values.keySet());
            ArrayList<String> keys = new ArrayList<>(filter.values.values());
            filterKVAdapter.setOnItemClickListener(new BaseQuickAdapter.OnItemClickListener() {
                View pre = null;

                @Override
                public void onItemClick(BaseQuickAdapter adapter, View view, int position) {
                    selectChange = true;
                    String filterSelect = sortData.filterSelect.get(key);
                    if (filterSelect == null || !filterSelect.equals(keys.get(position))) {
                        sortData.filterSelect.put(key, keys.get(position));
                        if (pre != null) {
                            TextView val = pre.findViewById(R.id.filterValue);
                            val.getPaint().setFakeBoldText(false);
                            val.setTextColor(getContext().getResources().getColor(R.color.color_FFFFFF));
                        }
                        TextView val = view.findViewById(R.id.filterValue);
                        val.getPaint().setFakeBoldText(true);
                        val.setTextColor(getContext().getResources().getColor(R.color.color_02F8E1));
                        pre = view;
                    } else {
                        sortData.filterSelect.remove(key);
                        TextView val = pre.findViewById(R.id.filterValue);
                        val.getPaint().setFakeBoldText(false);
                        val.setTextColor(getContext().getResources().getColor(R.color.color_FFFFFF));
                        pre = null;
                    }
                }
            });
            filterKVAdapter.setNewData(values);
            items.addView(line);
        }
    }

    private boolean selectChange = false;

    /** 计算半屏/全屏高度（按可用显示区，减去状态栏） */
    private void measureHeights() {
        DisplayMetrics dm = new DisplayMetrics();
        WindowManager wm = (WindowManager) getContext().getSystemService(Context.WINDOW_SERVICE);
        if (wm != null) {
            wm.getDefaultDisplay().getMetrics(dm);
            int usable = dm.heightPixels;
            halfHeightPx = Math.round(usable * HALF_RATIO);
            fullHeightPx = Math.round(usable * FULL_RATIO);
        }
    }

    private void applyHeight(int targetPx, boolean animate) {
        if (filterRoot == null || targetPx <= 0) return;
        ViewGroup.LayoutParams lp = filterRoot.getLayoutParams();
        if (lp == null) return;
        if (!animate || heightAnimator != null) {
            if (heightAnimator != null) heightAnimator.cancel();
            lp.height = targetPx;
            filterRoot.setLayoutParams(lp);
            return;
        }
        final int from = lp.height > 0 ? lp.height : targetPx;
        heightAnimator = ValueAnimator.ofInt(from, targetPx);
        heightAnimator.setDuration(240);
        heightAnimator.addUpdateListener(new ValueAnimator.AnimatorUpdateListener() {
            @Override
            public void onAnimationUpdate(ValueAnimator animation) {
                ViewGroup.LayoutParams p = filterRoot.getLayoutParams();
                if (p == null) return;
                p.height = (Integer) animation.getAnimatedValue();
                filterRoot.setLayoutParams(p);
            }
        });
        heightAnimator.start();
    }

    private void toggleDrawer(boolean wantExpand) {
        if (!MotionConfig.SECTION_DRAWER) return;
        if (wantExpand == expanded) return;
        expanded = wantExpand;
        applyHeight(expanded ? fullHeightPx : halfHeightPx, true);
    }

    private void bindDrawerHandle() {
        View handle = findViewById(R.id.tvFilterHandle);
        if (handle == null) return;
        // 手柄自己处理上下滑动手势（占用 OnTouchListener），不再叠加按压波纹绑定
        handle.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                toggleDrawer(!expanded);
            }
        });
        final float[] downY = new float[1];
        handle.setOnTouchListener(new View.OnTouchListener() {
            @Override
            public boolean onTouch(View v, MotionEvent event) {
                switch (event.getActionMasked()) {
                    case MotionEvent.ACTION_DOWN:
                        downY[0] = event.getY();
                        return false;
                    case MotionEvent.ACTION_UP:
                        float dy = event.getY() - downY[0];
                        if (dy < -SWIPE_SLOP) {
                            toggleDrawer(true);   // 上拉展开
                            return true;           // 吞掉此次 UP，避免触发 onClick 反向切换
                        } else if (dy > SWIPE_SLOP) {
                            toggleDrawer(false);  // 下拉回半屏
                            return true;
                        }
                        return false;              // 视为点击，交给 onClick 切换
                    default:
                        return false;
                }
            }
        });
    }

    public void show() {
        selectChange = false;
        super.show();
        WindowManager.LayoutParams layoutParams = getWindow().getAttributes();
        layoutParams.gravity = Gravity.BOTTOM;
        layoutParams.width = ViewGroup.LayoutParams.MATCH_PARENT;
        // 遮罩铺满全屏（MATCH_PARENT），这样点击面板外的暗色区域能被 root 捕获并关闭；
        // 面板本身由 filterRoot 的 layout_gravity="bottom" 贴底，高度按半屏/全屏两档动态设置。
        layoutParams.height = ViewGroup.LayoutParams.MATCH_PARENT;
        layoutParams.dimAmount = 0.62f;
        getWindow().getDecorView().setPadding(0, 0, 0, 0);
        getWindow().setAttributes(layoutParams);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND);
        measureHeights();
        expanded = false;
        applyHeight(halfHeightPx, false);
    }

    @Override
    public void onBackPressed() {
        // 遥控器返回键明确关闭筛选面板，避免筛选界面退不出去
        dismiss();
    }

    @Override
    public void dismiss() {
        if (heightAnimator != null) {
            heightAnimator.cancel();
            heightAnimator = null;
        }
        super.dismiss();
    }

    private void bindOutsideTouchDismiss() {
        View rootView = findViewById(R.id.root);
        rootView.setOnTouchListener(new View.OnTouchListener() {
            @Override
            public boolean onTouch(View v, MotionEvent event) {
                if (isTouchInsideFilter(event)) {
                    return false;
                }
                if (event.getAction() == MotionEvent.ACTION_UP) {
                    dismiss();
                    return true;
                }
                return event.getAction() == MotionEvent.ACTION_DOWN
                        || event.getAction() == MotionEvent.ACTION_MOVE
                        || event.getAction() == MotionEvent.ACTION_CANCEL;
            }
        });
    }

    private boolean isTouchInsideFilter(MotionEvent event) {
        return event.getX() >= filterRoot.getLeft()
                && event.getX() <= filterRoot.getRight()
                && event.getY() >= filterRoot.getTop()
                && event.getY() <= filterRoot.getBottom();
    }

}
