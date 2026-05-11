import jieba.analyse


res = jieba.analyse.extract_tags("我爱旅游和烧烤", topK=12)
print(res)
