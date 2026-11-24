package com.github.tvbox.osc.ui.adapter;

import android.util.TypedValue;
import android.widget.TextView;

import com.chad.library.adapter.base.BaseQuickAdapter;
import com.chad.library.adapter.base.BaseViewHolder;
import com.github.tvbox.osc.R;

import java.util.ArrayList;

public class PinyinAdapter extends BaseQuickAdapter<String, BaseViewHolder> {
    private int chipMinWidth;
    private int chipPadding;
    private int chipTextPx;

    public PinyinAdapter() {
        super(R.layout.item_search_word_hot, new ArrayList<>());
    }

    /** 搜索页按当前屏幕像素放大热词/历史词胶囊；不影响其它复用同一 item 布局的页面 */
    public void setMetrics(int minWidthPx, int paddingPx, int textPx) {
        this.chipMinWidth = minWidthPx;
        this.chipPadding = paddingPx;
        this.chipTextPx = textPx;
    }

    @Override
    protected void convert(BaseViewHolder helper, String item) {
        helper.setText(R.id.tvSearchWord, item);
        if (chipMinWidth > 0) {
            helper.itemView.setMinimumWidth(chipMinWidth);
        }
        if (chipPadding > 0) {
            int vertical = Math.max(4, chipPadding / 2);
            helper.itemView.setPadding(chipPadding, vertical, chipPadding, vertical);
        }
        if (chipTextPx > 0) {
            TextView word = helper.getView(R.id.tvSearchWord);
            if (word != null) {
                word.setTextSize(TypedValue.COMPLEX_UNIT_PX, chipTextPx);
            }
        }
    }
}
