package com.github.tvbox.osc.ui.adapter;

import android.util.TypedValue;
import android.widget.TextView;

import com.chad.library.adapter.base.BaseQuickAdapter;
import com.chad.library.adapter.base.BaseViewHolder;
import com.github.tvbox.osc.R;

import java.util.ArrayList;

public class GridFilterKVAdapter extends BaseQuickAdapter<String, BaseViewHolder> {
    // 筛选弹窗的 Dialog Context 未经过 AutoSize density 适配，mm 字号会被压小。
    // 改为由外部传入按屏幕计算的 px 字号，保证横竖屏都清晰可读。
    private final int textPx;

    public GridFilterKVAdapter() {
        this(26);
    }

    public GridFilterKVAdapter(int textPx) {
        super(R.layout.item_grid_filter_value, new ArrayList<>());
        this.textPx = textPx;
    }

    @Override
    protected void convert(BaseViewHolder helper, String item) {
        helper.setText(R.id.filterValue, item);
        TextView tv = helper.getView(R.id.filterValue);
        if (tv != null) {
            tv.setTextSize(TypedValue.COMPLEX_UNIT_PX, textPx);
        }
    }
}
