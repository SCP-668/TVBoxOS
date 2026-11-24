package com.github.tvbox.osc.ui.tv.widget;

import android.content.Context;
import android.util.AttributeSet;
import android.util.TypedValue;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.TextView;

import androidx.annotation.AttrRes;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.recyclerview.widget.GridLayoutManager;
import androidx.recyclerview.widget.RecyclerView;

import com.chad.library.adapter.base.BaseMultiItemQuickAdapter;
import com.chad.library.adapter.base.BaseQuickAdapter;
import com.chad.library.adapter.base.BaseViewHolder;
import com.chad.library.adapter.base.entity.MultiItemEntity;
import com.github.tvbox.osc.R;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;


/**
 * @author pj567
 * @date :2020/12/23
 * @description:
 */
public class SearchKeyboard extends FrameLayout {
    private RecyclerView mRecyclerView;
    private final List<String> keys = Arrays.asList("远程搜索", "删除", "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z", "1", "2", "3", "4", "5", "6", "7", "8", "9", "0");
    private final List<Keyboard> keyboardList = new ArrayList<>();
    private OnSearchKeyListener searchKeyListener;
    private final OnFocusChangeListener focusChangeListener = new OnFocusChangeListener() {
        @Override
        public void onFocusChange(View itemView, boolean hasFocus) {
            if (null != itemView && itemView != mRecyclerView) {
                itemView.setSelected(hasFocus);
            }
        }
    };
    private KeyboardAdapter keyboardAdapter;

    public SearchKeyboard(@NonNull Context context) {
        this(context, null);
    }

    public SearchKeyboard(@NonNull Context context, @Nullable AttributeSet attrs) {
        this(context, attrs, 0);
    }

    public SearchKeyboard(@NonNull Context context, @Nullable AttributeSet attrs, @AttrRes int defStyleAttr) {
        super(context, attrs, defStyleAttr);
        initView();
    }

    private void initView() {
        View view = LayoutInflater.from(getContext()).inflate(R.layout.layout_keyborad, this);
        mRecyclerView = view.findViewById(R.id.mRecyclerView);
        GridLayoutManager manager = new GridLayoutManager(getContext(), 6);
        mRecyclerView.setLayoutManager(manager);
        mRecyclerView.addOnChildAttachStateChangeListener(new RecyclerView.OnChildAttachStateChangeListener() {
            @Override
            public void onChildViewAttachedToWindow(@NonNull View child) {
                if (child.isFocusable() && null == child.getOnFocusChangeListener()) {
                    child.setOnFocusChangeListener(focusChangeListener);
                }
            }

            @Override
            public void onChildViewDetachedFromWindow(@NonNull View view) {

            }
        });
        int size = keys.size();
        for (int i = 0; i < size; i++) {
            keyboardList.add(new Keyboard(1, keys.get(i)));
        }
        keyboardAdapter = new KeyboardAdapter(keyboardList);
        mRecyclerView.setAdapter(keyboardAdapter);
        keyboardAdapter.setSpanSizeLookup(new BaseQuickAdapter.SpanSizeLookup() {
            @Override
            public int getSpanSize(GridLayoutManager gridLayoutManager, int position) {
                if (position == 0 || position == 1)
                    return 3;
                return 1;
            }
        });

        keyboardAdapter.setOnItemClickListener(new BaseQuickAdapter.OnItemClickListener() {
            @Override
            public void onItemClick(BaseQuickAdapter adapter, View view, int position) {
                Keyboard keyboard = (Keyboard) adapter.getItem(position);
                if (searchKeyListener != null && keyboard != null) {
                    searchKeyListener.onSearchKey(position, keyboard.getKey());
                }
            }
        });
    }

    /**
     * 搜索键盘按当前屏幕短边适配：竖屏放大按键与字号、增加间距，横屏保持紧凑。
     * 只影响搜索键盘自身，不动其它页面。
     */
    public void applyResponsive(int shortSide, boolean portrait) {
        if (mRecyclerView == null || keyboardAdapter == null || shortSide <= 0) return;
        int keyHeight = Math.round(shortSide * (portrait ? 0.068f : 0.070f));
        int keyMargin = Math.round(shortSide * (portrait ? 0.008f : 0.005f));
        int keyTextPx = Math.round(shortSide * (portrait ? 0.026f : 0.022f));
        keyboardAdapter.setMetrics(keyHeight, keyMargin, keyTextPx);
        keyboardAdapter.notifyDataSetChanged();
    }

    static class Keyboard implements MultiItemEntity {
        private final int itemType;
        private final String key;

        private Keyboard(int itemType, String key) {
            this.itemType = itemType;
            this.key = key;
        }

        @Override
        public int getItemType() {
            return itemType;
        }

        public String getKey() {
            return key;
        }
    }

    private static class KeyboardAdapter extends BaseMultiItemQuickAdapter<Keyboard, BaseViewHolder> {
        private int keyHeightPx;
        private int keyMarginPx;
        private int keyTextPx;

        private KeyboardAdapter(List<Keyboard> data) {
            super(data);
            addItemType(1, R.layout.item_keyboard);
        }

        private void setMetrics(int heightPx, int marginPx, int textPx) {
            this.keyHeightPx = heightPx;
            this.keyMarginPx = marginPx;
            this.keyTextPx = textPx;
        }

        @Override
        protected void convert(BaseViewHolder helper, Keyboard item) {
            switch (helper.getItemViewType()) {
                case 1:
                    helper.setText(R.id.keyName, item.getKey());
                    if (keyHeightPx > 0) {
                        ViewGroup.LayoutParams lp = helper.itemView.getLayoutParams();
                        if (lp == null) {
                            lp = new RecyclerView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, keyHeightPx);
                        } else {
                            lp.height = keyHeightPx;
                        }
                        if (lp instanceof ViewGroup.MarginLayoutParams) {
                            ((ViewGroup.MarginLayoutParams) lp).setMargins(keyMarginPx, keyMarginPx, keyMarginPx, keyMarginPx);
                        }
                        helper.itemView.setLayoutParams(lp);
                    }
                    if (keyTextPx > 0) {
                        TextView keyName = helper.getView(R.id.keyName);
                        if (keyName != null) {
                            keyName.setTextSize(TypedValue.COMPLEX_UNIT_PX, keyTextPx);
                        }
                    }
                    break;
            }
        }
    }

    public void setOnSearchKeyListener(OnSearchKeyListener listener) {
        searchKeyListener = listener;
    }

    public interface OnSearchKeyListener {
        void onSearchKey(int pos, String key);
    }
}
