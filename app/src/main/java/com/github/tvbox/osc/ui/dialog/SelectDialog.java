package com.github.tvbox.osc.ui.dialog;

import android.content.Context;
import android.os.Bundle;
import android.util.DisplayMetrics;
import android.view.View;
import android.view.ViewGroup;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.constraintlayout.widget.ConstraintLayout;
import androidx.recyclerview.widget.DiffUtil;
import androidx.recyclerview.widget.LinearLayoutManager;
import androidx.recyclerview.widget.RecyclerView;

import com.github.tvbox.osc.R;
import com.github.tvbox.osc.ui.adapter.SelectDialogAdapter;
import com.owen.tvrecyclerview.widget.GridLayoutManager;
import com.owen.tvrecyclerview.widget.TvRecyclerView;

import org.jetbrains.annotations.NotNull;

import java.util.List;

public class SelectDialog<T> extends BaseDialog {
    public SelectDialog(@NonNull @NotNull Context context) {
        super(context);
        setContentView(R.layout.dialog_select);
    }

    public SelectDialog(@NonNull @NotNull Context context, int resId) {
        super(context);
        setContentView(resId);
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
    }

    /**
     * 每次显示都按当前屏幕方向重算尺寸。
     * 弹窗实例是复用的，横屏创建后再切竖屏，如果只在创建时算一次，
     * 就会沿用横屏尺寸，表现为"竖屏弹窗巨大、超出屏幕"。
     */
    @Override
    public void show() {
        applyResponsiveSize();
        super.show();
    }

    private void applyResponsiveSize() {
        View root = findViewById(R.id.cl_root);
        if (root == null) return;
        DisplayMetrics dm = getContext().getResources().getDisplayMetrics();
        boolean portrait = dm.heightPixels > dm.widthPixels;

        // 宽度按当前屏幕像素比例算：竖屏接近满屏、横屏留白居中；不用 mm/dp 固定值，避免方向切换后过大
        ViewGroup.LayoutParams lp = root.getLayoutParams();
        if (lp != null) {
            lp.width = (int) (dm.widthPixels * (portrait ? 0.94f : 0.72f));
            root.setLayoutParams(lp);
        }

        // 限制列表最大高度，避免弹窗顶到状态栏、压住底部导航
        View list = findViewById(R.id.list);
        if (list != null && list.getLayoutParams() instanceof ConstraintLayout.LayoutParams) {
            ConstraintLayout.LayoutParams llp = (ConstraintLayout.LayoutParams) list.getLayoutParams();
            llp.matchConstraintMaxHeight = (int) (dm.heightPixels * (portrait ? 0.60f : 0.66f));
            list.setLayoutParams(llp);
        }
    }

    public void setTip(String tip) {
        ((TextView) findViewById(R.id.title)).setText(tip);
    }

    public void setAdapter(SelectDialogAdapter.SelectDialogInterface<T> sourceBeanSelectDialogInterface,
                           DiffUtil.ItemCallback<T> sourceBeanItemCallback,
                           List<T> data, int select) {
        final int selectIdx = select;
        SelectDialogAdapter<T> adapter = new SelectDialogAdapter<>(sourceBeanSelectDialogInterface, sourceBeanItemCallback);
        adapter.setData(data, select);
        TvRecyclerView tvRecyclerView = findViewById(R.id.list);
        tvRecyclerView.setAdapter(adapter);
        tvRecyclerView.setSelectedPosition(select);
        if (select<10){
            tvRecyclerView.setSelection(select);
        }
        tvRecyclerView.post(new Runnable() {
            @Override
            public void run() {
                if (selectIdx >= 10) {
                    tvRecyclerView.smoothScrollToPosition(selectIdx);
                    tvRecyclerView.setSelectionWithSmooth(selectIdx);
                }
            }
        });
    }

}
