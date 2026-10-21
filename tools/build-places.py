#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""足迹点亮 · 地名字典离线生成脚本（构建期运行一次，产物随版本分发）

数据源：阿里云 DataV.GeoAtlas（areas_v3，行政区划边界与 center 坐标）
  https://geo.datav.aliyun.com/areas_v3/bound/100000_full.json      省级 34 要素
  https://geo.datav.aliyun.com/areas_v3/bound/{adcode}_full.json    各地级市
名称/层级基准：GB/T 2260 行政区划代码（adcode）；拼音由 pypinyin 离线生成。
坐标取 properties.center（政府驻地），缺失时退回 centroid。

产物：server/places_data.js（CommonJS 模块，运行时零依赖零网络）
运行：python tools/build-places.py
"""
import json
import re
import sys
import time
import urllib.request
from pathlib import Path

from pypinyin import lazy_pinyin

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'server' / 'places_data.js'
CACHE = ROOT / 'tools' / '.geo-cache'
BASE = 'https://geo.datav.aliyun.com/areas_v3/bound/{}_full.json'

MUNICIPAL = {'110000', '120000', '310000', '500000'}          # 直辖市：不生成市级点
SPECIAL_REGION = {'810000', '820000', '710000'}               # 港澳、台湾省：省级点即可
SKIP_NAMES = {'市辖区', '县', '省直辖县级行政区划', '自治区直辖县级行政区划'}

ETHNIC = ('蒙古族|回族|藏族|维吾尔族|苗族|彝族|壮族|布依族|朝鲜族|满族|侗族|瑶族|白族|土家族|'
          '哈尼族|哈萨克族|傣族|黎族|傈僳族|佤族|畲族|高山族|拉祜族|水族|东乡族|纳西族|景颇族|'
          '柯尔克孜族|土族|达斡尔族|仫佬族|羌族|布朗族|撒拉族|毛南族|仡佬族|锡伯族|阿昌族|普米族|'
          '塔吉克族|怒族|乌孜别克族|俄罗斯族|鄂温克族|德昂族|保安族|裕固族|京族|塔塔尔族|独龙族|'
          '鄂伦春族|赫哲族|门巴族|珞巴族|基诺族')


def fetch(adcode: str) -> dict:
    CACHE.mkdir(exist_ok=True)
    fp = CACHE / f'{adcode}_full.json'
    if fp.exists():
        return json.loads(fp.read_text(encoding='utf-8'))
    url = BASE.format(adcode)
    req = urllib.request.Request(url, headers={'User-Agent': 'places-builder/1.0'})
    with urllib.request.urlopen(req, timeout=30) as r:
        data = json.loads(r.read().decode('utf-8'))
    fp.write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')
    time.sleep(0.15)
    return data


def py(name: str) -> str:
    return ''.join(lazy_pinyin(name))


def abbr(name: str) -> str:
    return ''.join(p[0] for p in lazy_pinyin(name) if p)


def province_short(name: str) -> str:
    for suf in ('特别行政区', '维吾尔自治区', '壮族自治区', '回族自治区', '自治区', '省', '市'):
        if name.endswith(suf):
            return name[:-len(suf)]
    return name


def city_short(name: str) -> str:
    n = name
    if n.endswith('自治州'):
        n = n[:-3]
        prev = None
        while prev != n:
            prev = n
            n = re.sub(r'(' + ETHNIC + r')$', '', n)
    elif n.endswith('地区'):
        n = n[:-2]
    elif n.endswith('盟') or n.endswith('市'):
        n = n[:-1]
    return n or name


def coord(props: dict):
    c = props.get('center') or props.get('centroid')
    if not c or len(c) != 2:
        return None
    lng, lat = float(c[0]), float(c[1])
    if not (73 <= lng <= 136 and 17 <= lat <= 54):
        return None
    return round(lng, 4), round(lat, 4)


# DataV 缺失坐标的行政区（政府驻地，公知事实数据）：三沙市政府驻西沙永兴岛
COORD_OVERRIDES = {'460300': (112.3386, 16.8314)}


# 常见国际目的地（国家级点亮，坐标取首都/政府驻地，公知事实数据）
COUNTRIES = [
    ('JP', '日本', 139.6917, 35.6895), ('KR', '韩国', 126.9780, 37.5665), ('TH', '泰国', 100.5018, 13.7563),
    ('SG', '新加坡', 103.8198, 1.3521), ('MY', '马来西亚', 101.6869, 3.1390), ('ID', '印度尼西亚', 106.8456, -6.2088),
    ('VN', '越南', 105.8342, 21.0278), ('PH', '菲律宾', 120.9842, 14.5995), ('KH', '柬埔寨', 104.9160, 11.5564),
    ('LA', '老挝', 102.6331, 17.9757), ('MM', '缅甸', 96.1561, 21.9162), ('BN', '文莱', 114.9420, 4.9031),
    ('TL', '东帝汶', 125.5736, -8.5569), ('IN', '印度', 77.2090, 28.6139), ('NP', '尼泊尔', 85.3240, 27.7172),
    ('BT', '不丹', 89.6330, 27.4728), ('LK', '斯里兰卡', 79.8612, 6.9271), ('MV', '马尔代夫', 73.5093, 4.1755),
    ('PK', '巴基斯坦', 73.0479, 33.6844), ('BD', '孟加拉国', 90.4125, 23.8103), ('AF', '阿富汗', 69.2075, 34.5553),
    ('KZ', '哈萨克斯坦', 71.4491, 51.1694), ('UZ', '乌兹别克斯坦', 69.2401, 41.2995), ('KG', '吉尔吉斯斯坦', 74.5698, 42.8746),
    ('TJ', '塔吉克斯坦', 68.7870, 38.5598), ('TM', '土库曼斯坦', 58.3833, 37.9601), ('MN', '蒙古', 106.9057, 47.8864),
    ('RU', '俄罗斯', 37.6173, 55.7558), ('KP', '朝鲜', 125.7625, 39.0392), ('AE', '阿联酋', 54.3773, 24.4539),
    ('SA', '沙特阿拉伯', 46.6753, 24.7136), ('QA', '卡塔尔', 51.5310, 25.2854), ('KW', '科威特', 47.9783, 29.3759),
    ('BH', '巴林', 50.5832, 26.2285), ('OM', '阿曼', 58.4059, 23.5880), ('IQ', '伊拉克', 44.3615, 33.3152),
    ('IR', '伊朗', 51.3890, 35.6892), ('IL', '以色列', 35.2137, 31.7683), ('JO', '约旦', 35.9306, 31.9454),
    ('LB', '黎巴嫩', 35.5018, 33.8938), ('TR', '土耳其', 32.8597, 39.9334), ('EG', '埃及', 31.2357, 30.0444),
    ('GB', '英国', -0.1276, 51.5074), ('IE', '爱尔兰', -6.2603, 53.3498), ('FR', '法国', 2.3522, 48.8566),
    ('DE', '德国', 13.4050, 52.5200), ('IT', '意大利', 12.4964, 41.9028), ('ES', '西班牙', -3.7038, 40.4168),
    ('PT', '葡萄牙', -9.1393, 38.7223), ('NL', '荷兰', 4.8952, 52.3702), ('BE', '比利时', 4.3517, 50.8503),
    ('LU', '卢森堡', 6.1296, 49.6116), ('CH', '瑞士', 7.4474, 46.9480), ('AT', '奥地利', 16.3738, 48.2082),
    ('CZ', '捷克', 14.4378, 50.0755), ('PL', '波兰', 21.0122, 52.2297), ('HU', '匈牙利', 19.0402, 47.4979),
    ('SK', '斯洛伐克', 17.1077, 48.1486), ('SI', '斯洛文尼亚', 14.5058, 46.0569), ('HR', '克罗地亚', 15.9819, 45.8150),
    ('GR', '希腊', 23.7275, 37.9838), ('SE', '瑞典', 18.0686, 59.3293), ('NO', '挪威', 10.7522, 59.9139),
    ('FI', '芬兰', 24.9384, 60.1699), ('DK', '丹麦', 12.5683, 55.6761), ('IS', '冰岛', -21.9426, 64.1466),
    ('EE', '爱沙尼亚', 24.7536, 59.4370), ('LV', '拉脱维亚', 24.1052, 56.9496), ('LT', '立陶宛', 25.2797, 54.6872),
    ('UA', '乌克兰', 30.5234, 50.4501), ('BY', '白俄罗斯', 27.5590, 53.9006), ('MD', '摩尔多瓦', 28.8638, 47.0105),
    ('RO', '罗马尼亚', 26.1025, 44.4268), ('BG', '保加利亚', 23.3219, 42.6977), ('RS', '塞尔维亚', 20.4489, 44.7866),
    ('US', '美国', -77.0369, 38.9072), ('CA', '加拿大', -75.6952, 45.4215), ('MX', '墨西哥', -99.1332, 19.4326),
    ('CU', '古巴', -82.3666, 23.1136), ('BR', '巴西', -47.9292, -15.7801), ('AR', '阿根廷', -58.3816, -34.6037),
    ('CL', '智利', -70.6693, -33.4489), ('PE', '秘鲁', -77.0428, -12.0464), ('CO', '哥伦比亚', -74.0721, 4.7110),
    ('AU', '澳大利亚', 149.1300, -35.2809), ('NZ', '新西兰', 174.7762, -41.2865), ('FJ', '斐济', 178.4419, -18.1416),
    ('PG', '巴布亚新几内亚', 147.1803, -9.4438), ('ZA', '南非', 28.1881, -25.7460), ('MA', '摩洛哥', -6.8498, 34.0209),
    ('TN', '突尼斯', 10.1815, 36.8065), ('KE', '肯尼亚', 36.8219, -1.2921), ('ET', '埃塞俄比亚', 38.7469, 9.0054),
    ('TZ', '坦桑尼亚', 35.7516, -6.1630), ('MU', '毛里求斯', 57.5012, -20.1609), ('SC', '塞舌尔', 55.4515, -4.6191),
    ('MG', '马达加斯加', 47.5079, -18.8792), ('NA', '纳米比亚', 17.0832, -22.5597), ('GH', '加纳', -0.1869, 5.6037),
]


def main() -> int:
    top = fetch('100000')
    entries = []
    seen_short = {}  # 城市简名冲突检测（仅用于警告与特例）

    prov_map = {}  # adcode -> 省短名
    for f in top['features']:
        p = f['properties']
        ad = str(p.get('adcode', ''))
        if not re.fullmatch(r'\d{6}', ad) or not ad.endswith('0000'):
            continue  # 跳过 100000_JD（十段线要素）等非省要素
        c = coord(p)
        if not c:
            print(f'!! 省级缺坐标: {ad} {p.get("name")}', file=sys.stderr)
            continue
        short = province_short(p['name'])
        prov_map[ad] = short
        entries.append(dict(adcode=ad, country='中国', province=short, city=None,
                            name=short, pinyin=py(short), abbr=abbr(short),
                            lng=c[0], lat=c[1], level='province'))
        # 地级市中心点
        if ad in MUNICIPAL or ad in SPECIAL_REGION:
            continue
        sub = fetch(ad)
        for sf in sub['features']:
            sp = sf['properties']
            sad = str(sp.get('adcode', ''))
            sname = sp.get('name') or ''
            if not re.fullmatch(r'\d{6}', sad) or not sad.endswith('00'):
                continue  # 只取地级市（xxYY00），排除区县与虚拟汇总
            if sname in SKIP_NAMES:
                continue
            sc = COORD_OVERRIDES.get(sad) or coord(sp)
            if not sc:
                print(f'!! 市级缺坐标: {sad} {sname}', file=sys.stderr)
                continue
            short = city_short(sname)
            if short in prov_map.values():  # 如「海南藏族自治州」→ 海南州（避免与省同名）
                short = re.sub(r'(' + ETHNIC + r')$', '', sname[:-3] if sname.endswith('自治州') else sname) + '州'
            if short in seen_short and seen_short[short] != prov_map[ad]:
                print(f'-- 同名城市跨省份: {short} ({prov_map[ad]} / {seen_short[short]})，以省份前缀区分', file=sys.stderr)
            seen_short.setdefault(short, prov_map[ad])
            entries.append(dict(adcode=sad, country='中国', province=prov_map[ad], city=sname,
                                name=short, pinyin=py(short), abbr=abbr(short),
                                lng=sc[0], lat=sc[1], level='city'))

    for code, name, lng, lat in COUNTRIES:
        entries.append(dict(adcode=code, country=name, province=None, city=None,
                            name=name, pinyin=py(name), abbr=abbr(name),
                            lng=lng, lat=lat, level='country'))

    provs = [e for e in entries if e['level'] == 'province']
    cities = [e for e in entries if e['level'] == 'city']
    countries = [e for e in entries if e['level'] == 'country']
    print(f'省级 {len(provs)}，地级市 {len(cities)}，国家 {len(countries)}，合计 {len(entries)}')
    assert len(provs) == 34, '省级要素必须为 34（含台湾省、港澳）'
    assert any(e['province'] == '台湾' for e in provs), '必须包含台湾省'
    assert any(e['name'] == '三沙' for e in cities), '必须包含三沙市（南海诸岛）'

    js = ('/* 地名字典（自动生成的数据文件，勿手改；重新生成：python tools/build-places.py）\n'
          ' * 数据源：DataV.GeoAtlas areas_v3 行政区划 center 坐标 + GB/T 2260 名称层级；\n'
          ' * 拼音由 pypinyin 离线生成；国家条目坐标为首都/政府驻地（公知事实数据）。 */\n'
          "'use strict';\nmodule.exports = "
          + json.dumps(entries, ensure_ascii=False, separators=(',', ':')) + ';\n')
    OUT.write_text(js, encoding='utf-8', newline='\n')  # 强制 LF，跨平台一致（Windows 默认会转为 CRLF）
    print(f'已写出 {OUT}（{OUT.stat().st_size / 1024:.1f} KB）')
    return 0


if __name__ == '__main__':
    sys.exit(main())
