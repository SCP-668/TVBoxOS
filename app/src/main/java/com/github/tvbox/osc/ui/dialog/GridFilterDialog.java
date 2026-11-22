package com.github.tvbox.osc.ui.dialog;

import android.content.Context;
import android.content.DialogInterface;
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
import com.owen.tvrecyclerview.widget.TvRecyclerView;
import com.owen.tvrecyclerview.widget.V7LinearLayoutManager;

import org.jetbrains.annotations.NotNull;

import java.util.ArrayList;

public class GridFilterDialog extends BaseDialog {
    public LinearLayout filterRoot;

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
        }

        bindOutsideTouchDismiss();
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
        for (MovieSort.SortFilter filter : filters) {
            View line = LayoutInflater.from(getContext()).inflate(R.layout.item_grid_filter, null);
            ((TextView) line.findViewById(R.id.filterName)).setText(filter.name);
            TvRecyclerView gridView = line.findViewById(R.id.mFilterKv);
            gridView.setHasFixedSize(true);
            gridView.setLayoutManager(new V7LinearLayoutManager(getContext(), 0, false));
            GridFilterKVAdapter filterKVAdapter = new GridFilterKVAdapter();
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
            filterRoot.addView(line);
        }
    }

    private boolean selectChange = false;

    public void show() {
        selectChange = false;
        super.show();
        WindowManager.LayoutParams layoutParams = getWindow().getAttributes();
        layoutParams.gravity = Gravity.BOTTOM;
        layoutParams.width = ViewGroup.LayoutParams.MATCH_PARENT;
        // 遮罩铺满全屏（MATCH_PARENT），这样点击面板外的暗色区域能被 root 捕获并关闭；
        // 之前用 WRAP_CONTENT 贴底导致遮罩没有可点区域、面板退不出去。
        // 面板本身仍由 filterRoot 的 layout_gravity="bottom" 贴底、高度自适应内容。
        layoutParams.height = ViewGroup.LayoutParams.MATCH_PARENT;
        layoutParams.dimAmount = 0.62f;
        getWindow().getDecorView().setPadding(0, 0, 0, 0);
        getWindow().setAttributes(layoutParams);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND);
//        requestFirstFilterFocus();
    }

    @Override
    public void onBackPressed() {
        // 遥控器返回键明确关闭筛选面板，避免筛选界面退不出去
        dismiss();
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

    private void requestFirstFilterFocus() {
        filterRoot.postDelayed(new Runnable() {
            @Override
            public void run() {
                View target = findFocusableChild(filterRoot);
                if (target != null) {
                    target.requestFocus();
                }
            }
        }, 100);
    }

    private View findFocusableChild(View view) {
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) view;
            for (int i = 0; i < group.getChildCount(); i++) {
                View child = findFocusableChild(group.getChildAt(i));
                if (child != null) {
                    return child;
                }
            }
        }
        return view.isFocusable() ? view : null;
    }

}
