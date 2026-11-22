package com.github.tvbox.osc.ui.adapter;

import android.text.TextUtils;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.widget.ImageView;

import com.chad.library.adapter.base.BaseQuickAdapter;
import com.chad.library.adapter.base.BaseViewHolder;
import com.github.tvbox.osc.R;
import com.github.tvbox.osc.api.ApiConfig;
import com.github.tvbox.osc.bean.Movie;
import com.github.tvbox.osc.util.ImgUtil;

import java.util.ArrayList;

import me.jessyan.autosize.utils.AutoSizeUtils;

public class FastSearchAdapter extends BaseQuickAdapter<Movie.Video, BaseViewHolder> {
    private static final String TAG = "FastSearchAdapter";

    /** 卡片尺寸由 FastSearchActivity 按网格实测列宽写入，避免写死 214×280mm 导致竖屏重叠、不居中 */
    private int cardW = 0;
    private int cardH = 0;
    private int shortSide = 0;

    public void setMetrics(int cardW, int cardH, int shortSide) {
        this.cardW = cardW;
        this.cardH = cardH;
        this.shortSide = shortSide;
    }

    public FastSearchAdapter() {
        super(R.layout.item_search, new ArrayList<>());
    }

    @Override
    protected void convert(BaseViewHolder helper, Movie.Video item) {
        helper.setText(R.id.tvName, item.name);
        com.github.tvbox.osc.bean.SourceBean source = ApiConfig.get().getSource(item.sourceKey);
        helper.setText(R.id.tvSite, source == null ? "" : source.getName());
        helper.setVisible(R.id.tvNote, item.note != null && !item.note.isEmpty());
        if (item.note != null && !item.note.isEmpty()) helper.setText(R.id.tvNote, item.note);
        ImageView ivThumb = helper.getView(R.id.ivThumb);
        int loadW = cardW > 0 ? cardW : AutoSizeUtils.mm2px(mContext, ImgUtil.defaultWidth);
        int loadH = cardH > 0 ? cardH : AutoSizeUtils.mm2px(mContext, ImgUtil.defaultHeight);
        String pic = item.pic == null ? "" : item.pic.trim();
        if (!TextUtils.isEmpty(pic)) {
            if (ImgUtil.isBase64Image(pic)) {
                ivThumb.setImageBitmap(ImgUtil.decodeBase64ToBitmap(pic));
            } else {
                ImgUtil.load(pic, ivThumb, AutoSizeUtils.mm2px(mContext, 10), loadW, loadH, item.name);
            }
        } else {
            Log.d(TAG, "empty image for item: " + item.name);
            ivThumb.setImageDrawable(ImgUtil.createTextDrawable(item.name));
        }
        applyCardSize(helper, ivThumb);
    }

    private void applyCardSize(BaseViewHolder helper, ImageView ivThumb) {
        if (cardW <= 0 || cardH <= 0) return;
        // item 宽度固定为列宽（不能 wrap_content，否则网格均分列宽后卡片错位重叠）；
        // 内层海报容器撑满列宽、高度按比例固定。
        View itemView = helper.itemView;
        ViewGroup.LayoutParams ilp = itemView.getLayoutParams();
        if (ilp != null) {
            ilp.width = cardW;
            ilp.height = ViewGroup.LayoutParams.WRAP_CONTENT;
            itemView.setLayoutParams(ilp);
        }
        ViewGroup container = (ViewGroup) ivThumb.getParent();
        ViewGroup.LayoutParams clp = container.getLayoutParams();
        clp.width = ViewGroup.LayoutParams.MATCH_PARENT;
        clp.height = cardH;
        container.setLayoutParams(clp);
    }
}
