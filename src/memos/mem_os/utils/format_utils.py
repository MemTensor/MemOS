import json
from typing import Dict, List, Any

import random
import json
from typing import Dict, List, Any, Set, Tuple
import math

from memos.memories.activation.item import KVCacheItem
from memos.log import get_logger

logger = get_logger(__name__)


def extract_node_name(memory: str) -> str:
    """从memory中提取前两个词作为node_name"""
    if not memory:
        return ""
    
    words = [word.strip() for word in memory.split() if word.strip()]
    
    if len(words) >= 2:
        return " ".join(words[:2])
    elif len(words) == 1:
        return words[0]
    else:
        return ""

def analyze_tree_structure_enhanced(nodes: List[Dict], edges: List[Dict]) -> Dict:
    """增强的树结构分析，重点关注分支度和叶子分布"""
    # 构建邻接表
    adj_list = {}
    reverse_adj = {}
    for edge in edges:
        source, target = edge['source'], edge['target']
        adj_list.setdefault(source, []).append(target)
        reverse_adj.setdefault(target, []).append(source)
    
    # 找到所有节点和根节点
    all_nodes = {node['id'] for node in nodes}
    target_nodes = {edge['target'] for edge in edges}
    root_nodes = all_nodes - target_nodes
    
    subtree_analysis = {}
    
    def analyze_subtree_enhanced(root_id: str) -> Dict:
        """增强的子树分析，重点评估分支度和结构质量"""
        visited = set()
        max_depth = 0
        leaf_count = 0
        total_nodes = 0
        branch_nodes = 0  # 有多个子节点的分支节点数
        chain_length = 0  # 最长单链长度
        width_per_level = {}  # 每层的宽度
        
        def dfs(node_id: str, depth: int, chain_len: int):
            nonlocal max_depth, leaf_count, total_nodes, branch_nodes, chain_length
            
            if node_id in visited:
                return
            
            visited.add(node_id)
            total_nodes += 1
            max_depth = max(max_depth, depth)
            chain_length = max(chain_length, chain_len)
            
            # 记录每层的节点数
            width_per_level[depth] = width_per_level.get(depth, 0) + 1
            
            children = adj_list.get(node_id, [])
            
            if not children:  # 叶子节点
                leaf_count += 1
            elif len(children) > 1:  # 分支节点
                branch_nodes += 1
                # 重置单链长度，因为遇到了分支
                for child in children:
                    dfs(child, depth + 1, 0)
            else:  # 单子节点（链式结构）
                for child in children:
                    dfs(child, depth + 1, chain_len + 1)
        
        dfs(root_id, 0, 0)
        
        # 计算结构质量指标
        avg_width = sum(width_per_level.values()) / len(width_per_level) if width_per_level else 0
        max_width = max(width_per_level.values()) if width_per_level else 0
        
        # 计算分支密度：分支节点占总节点的比例
        branch_density = branch_nodes / total_nodes if total_nodes > 0 else 0
        
        # 计算深度广度比：理想的树应该有适中的深度和较好的广度
        depth_width_ratio = max_depth / max_width if max_width > 0 else max_depth
        
        quality_score = calculate_enhanced_quality(
            max_depth, leaf_count, total_nodes, branch_nodes, 
            chain_length, branch_density, depth_width_ratio, max_width
        )
        
        return {
            'root_id': root_id,
            'max_depth': max_depth,
            'leaf_count': leaf_count,
            'total_nodes': total_nodes,
            'branch_nodes': branch_nodes,
            'max_chain_length': chain_length,
            'branch_density': branch_density,
            'max_width': max_width,
            'avg_width': avg_width,
            'depth_width_ratio': depth_width_ratio,
            'nodes_in_subtree': list(visited),
            'quality_score': quality_score,
            'width_per_level': width_per_level
        }
    
    for root_id in root_nodes:
        subtree_analysis[root_id] = analyze_subtree_enhanced(root_id)
    
    return subtree_analysis

def calculate_enhanced_quality(max_depth: int, leaf_count: int, total_nodes: int, 
                             branch_nodes: int, max_chain_length: int, 
                             branch_density: float, depth_width_ratio: float, max_width: int) -> float:
    """增强的质量计算，优先考虑分支度和叶子分布"""
    
    if total_nodes <= 1:
        return 0.1
    
    # 1. 分支质量分数 (权重: 35%)
    # 分支节点数量分数
    branch_count_score = min(branch_nodes * 3, 15)  # 每个分支节点3分，最高15分
    
    # 分支密度分数：理想密度在20%-60%之间
    if 0.2 <= branch_density <= 0.6:
        branch_density_score = 10
    elif branch_density > 0.6:
        branch_density_score = max(5, 10 - (branch_density - 0.6) * 20)
    else:
        branch_density_score = branch_density * 25  # 0-20%线性增长
    
    branch_score = (branch_count_score + branch_density_score) * 0.35
    
    # 2. 叶子质量分数 (权重: 25%)
    # 叶子数量分数
    leaf_count_score = min(leaf_count * 2, 20)
    
    # 叶子分布分数：叶子占总节点的理想比例30%-70%
    leaf_ratio = leaf_count / total_nodes
    if 0.3 <= leaf_ratio <= 0.7:
        leaf_ratio_score = 10
    elif leaf_ratio > 0.7:
        leaf_ratio_score = max(3, 10 - (leaf_ratio - 0.7) * 20)
    else:
        leaf_ratio_score = leaf_ratio * 20  # 0-30%线性增长
    
    leaf_score = (leaf_count_score + leaf_ratio_score) * 0.25
    
    # 3. 结构平衡分数 (权重: 25%)
    # 深度分数：适中深度最好（3-8层）
    if 3 <= max_depth <= 8:
        depth_score = 15
    elif max_depth < 3:
        depth_score = max_depth * 3  # 1-2层给较低分
    else:
        depth_score = max(5, 15 - (max_depth - 8) * 1.5)  # 超过8层逐渐减分
    
    # 宽度分数：最大宽度越大越好，但有上限
    width_score = min(max_width * 1.5, 15)
    
    # 深度宽度比惩罚：比值过大说明树太"细长"
    if depth_width_ratio > 3:
        ratio_penalty = (depth_width_ratio - 3) * 2
        structure_score = max(0, (depth_score + width_score - ratio_penalty)) * 0.25
    else:
        structure_score = (depth_score + width_score) * 0.25
    
    # 4. 链式结构惩罚 (权重: 15%)
    # 最长单链长度惩罚：单链过长严重影响展示效果
    if max_chain_length <= 2:
        chain_penalty_score = 10
    elif max_chain_length <= 5:
        chain_penalty_score = 8 - (max_chain_length - 2)
    else:
        chain_penalty_score = max(0, 3 - (max_chain_length - 5) * 0.5)
    
    chain_score = chain_penalty_score * 0.15
    
    # 5. 综合计算
    total_score = branch_score + leaf_score + structure_score + chain_score
    
    # 特殊情况严重惩罚
    if max_chain_length > total_nodes * 0.8:  # 如果80%以上都是单链
        total_score *= 0.3
    elif branch_density < 0.1 and total_nodes > 5:  # 几乎没有分支的大树
        total_score *= 0.5
    
    return total_score

def sample_nodes_with_type_balance(nodes: List[Dict], edges: List[Dict], 
                                 target_count: int = 150,
                                 type_ratios: Dict[str, float] = None) -> Tuple[List[Dict], List[Dict]]:
    """
    根据类型比例和树质量进行平衡采样
    
    Args:
        nodes: 节点列表
        edges: 边列表
        target_count: 目标节点数
        type_ratios: 各类型期望占比，如 {'WorkingMemory': 0.15, 'EpisodicMemory': 0.30, ...}
    """
    if len(nodes) <= target_count:
        return nodes, edges
    
    # 默认类型比例配置
    if type_ratios is None:
        type_ratios = {
            'WorkingMemory': 0.10,      # 10%
            'EpisodicMemory': 0.25,     # 25%
            'SemanticMemory': 0.25,     # 25%
            'ProceduralMemory': 0.20,   # 20%
            'EmotionalMemory': 0.15,    # 15%
            'MetaMemory': 0.05          # 5%
        }
    
    print(f"开始类型平衡采样，原始节点数: {len(nodes)}, 目标节点数: {target_count}")
    print(f"目标类型比例: {type_ratios}")
    
    # 分析当前节点的类型分布
    current_type_counts = {}
    nodes_by_type = {}
    
    for node in nodes:
        memory_type = node.get('metadata', {}).get('memory_type', 'Unknown')
        current_type_counts[memory_type] = current_type_counts.get(memory_type, 0) + 1
        if memory_type not in nodes_by_type:
            nodes_by_type[memory_type] = []
        nodes_by_type[memory_type].append(node)
    
    print(f"当前类型分布: {current_type_counts}")
    
    # 计算每个类型的目标节点数
    type_targets = {}
    remaining_target = target_count
    
    for memory_type, ratio in type_ratios.items():
        if memory_type in nodes_by_type:
            target_for_type = int(target_count * ratio)
            # 确保不超过该类型的实际节点数
            target_for_type = min(target_for_type, len(nodes_by_type[memory_type]))
            type_targets[memory_type] = target_for_type
            remaining_target -= target_for_type
    
    # 处理未在比例配置中的类型
    other_types = set(nodes_by_type.keys()) - set(type_ratios.keys())
    if other_types and remaining_target > 0:
        per_other_type = max(1, remaining_target // len(other_types))
        for memory_type in other_types:
            allocation = min(per_other_type, len(nodes_by_type[memory_type]))
            type_targets[memory_type] = allocation
            remaining_target -= allocation
    
    # 如果还有剩余，按比例分配给主要类型
    if remaining_target > 0:
        main_types = [t for t in type_ratios.keys() if t in nodes_by_type]
        if main_types:
            extra_per_type = remaining_target // len(main_types)
            for memory_type in main_types:
                additional = min(extra_per_type, 
                               len(nodes_by_type[memory_type]) - type_targets.get(memory_type, 0))
                type_targets[memory_type] = type_targets.get(memory_type, 0) + additional
    
    print(f"各类型目标节点数: {type_targets}")
    
    # 对每个类型进行子树质量采样
    selected_nodes = []
    
    for memory_type, target_for_type in type_targets.items():
        if target_for_type <= 0 or memory_type not in nodes_by_type:
            continue
        
        type_nodes = nodes_by_type[memory_type]
        print(f"\n--- 处理 {memory_type} 类型: {len(type_nodes)} -> {target_for_type} ---")
        
        if len(type_nodes) <= target_for_type:
            selected_nodes.extend(type_nodes)
            print(f"  全部选择: {len(type_nodes)} 个节点")
        else:
            # 使用增强的子树质量采样
            type_selected = sample_by_enhanced_subtree_quality(
                type_nodes, edges, target_for_type
            )
            selected_nodes.extend(type_selected)
            print(f"  采样选择: {len(type_selected)} 个节点")
    
    # 过滤边
    selected_node_ids = {node['id'] for node in selected_nodes}
    filtered_edges = [edge for edge in edges 
                     if edge['source'] in selected_node_ids and edge['target'] in selected_node_ids]
    
    print(f"\n最终选择节点数: {len(selected_nodes)}")
    print(f"最终边数: {len(filtered_edges)}")
    
    # 验证最终类型分布
    final_type_counts = {}
    for node in selected_nodes:
        memory_type = node.get('metadata', {}).get('memory_type', 'Unknown')
        final_type_counts[memory_type] = final_type_counts.get(memory_type, 0) + 1
    
    print(f"最终类型分布: {final_type_counts}")
    for memory_type, count in final_type_counts.items():
        percentage = count / len(selected_nodes) * 100
        target_percentage = type_ratios.get(memory_type, 0) * 100
        print(f"  {memory_type}: {count} 个 ({percentage:.1f}%, 目标: {target_percentage:.1f}%)")
    
    return selected_nodes, filtered_edges

def sample_by_enhanced_subtree_quality(nodes: List[Dict], edges: List[Dict], target_count: int) -> List[Dict]:
    """使用增强的子树质量进行采样"""
    if len(nodes) <= target_count:
        return nodes
    
    # 分析子树结构
    subtree_analysis = analyze_tree_structure_enhanced(nodes, edges)
    
    if not subtree_analysis:
        # 如果没有子树结构，按节点重要性采样
        return sample_nodes_by_importance(nodes, edges, target_count)
    
    # 按质量分数排序子树
    sorted_subtrees = sorted(subtree_analysis.items(), 
                           key=lambda x: x[1]['quality_score'], reverse=True)
    
    print(f"  子树质量排序:")
    for i, (root_id, analysis) in enumerate(sorted_subtrees[:5]):
        print(f"    #{i+1} 根节点 {root_id}: 质量={analysis['quality_score']:.2f}, "
              f"深度={analysis['max_depth']}, 分支={analysis['branch_nodes']}, "
              f"叶子={analysis['leaf_count']}, 最大宽度={analysis['max_width']}")
    
    # 贪心选择高质量子树
    selected_nodes = []
    selected_node_ids = set()
    
    for root_id, analysis in sorted_subtrees:
        subtree_nodes = analysis['nodes_in_subtree']
        new_nodes = [node_id for node_id in subtree_nodes if node_id not in selected_node_ids]
        
        if not new_nodes:
            continue
        
        remaining_quota = target_count - len(selected_nodes)
        
        if len(new_nodes) <= remaining_quota:
            # 整个子树都能加入
            for node_id in new_nodes:
                node = next((n for n in nodes if n['id'] == node_id), None)
                if node:
                    selected_nodes.append(node)
                    selected_node_ids.add(node_id)
            print(f"    选择整个子树 {root_id}: +{len(new_nodes)} 节点")
        else:
            # 子树太大，需要部分选择
            if analysis['quality_score'] > 5:  # 只对高质量子树进行部分选择
                subtree_node_objects = [n for n in nodes if n['id'] in new_nodes]
                partial_selection = select_best_nodes_from_subtree(
                    subtree_node_objects, edges, remaining_quota, root_id
                )
                
                selected_nodes.extend(partial_selection)
                for node in partial_selection:
                    selected_node_ids.add(node['id'])
                print(f"    部分选择子树 {root_id}: +{len(partial_selection)} 节点")
        
        if len(selected_nodes) >= target_count:
            break
    
    # 如果还没达到目标数量，补充剩余节点
    if len(selected_nodes) < target_count:
        remaining_nodes = [n for n in nodes if n['id'] not in selected_node_ids]
        remaining_count = target_count - len(selected_nodes)
        additional = sample_nodes_by_importance(remaining_nodes, edges, remaining_count)
        selected_nodes.extend(additional)
        print(f"    补充选择: +{len(additional)} 节点")
    
    return selected_nodes

def select_best_nodes_from_subtree(subtree_nodes: List[Dict], edges: List[Dict], 
                                 max_count: int, root_id: str) -> List[Dict]:
    """从子树中选择最重要的节点，优先保持分支结构"""
    if len(subtree_nodes) <= max_count:
        return subtree_nodes
    
    # 构建子树内部的连接关系
    subtree_node_ids = {node['id'] for node in subtree_nodes}
    subtree_edges = [edge for edge in edges 
                    if edge['source'] in subtree_node_ids and edge['target'] in subtree_node_ids]
    
    # 计算每个节点的重要性分数
    node_scores = []
    
    for node in subtree_nodes:
        node_id = node['id']
        
        # 出度和入度
        out_degree = sum(1 for edge in subtree_edges if edge['source'] == node_id)
        in_degree = sum(1 for edge in subtree_edges if edge['target'] == node_id)
        
        # 内容长度分数
        content_score = min(len(node.get('memory', '')), 300) / 15
        
        # 分支节点额外加分
        branch_bonus = out_degree * 8 if out_degree > 1 else 0
        
        # 根节点额外加分
        root_bonus = 15 if node_id == root_id else 0
        
        # 连接重要性
        connection_score = (out_degree + in_degree) * 3
        
        # 叶子节点适度加分（保证一定的叶子节点）
        leaf_bonus = 5 if out_degree == 0 and in_degree > 0 else 0
        
        total_score = content_score + connection_score + branch_bonus + root_bonus + leaf_bonus
        node_scores.append((node, total_score))
    
    # 按分数排序并选择
    node_scores.sort(key=lambda x: x[1], reverse=True)
    selected = [node for node, _ in node_scores[:max_count]]
    
    return selected

def sample_nodes_by_importance(nodes: List[Dict], edges: List[Dict], target_count: int) -> List[Dict]:
    """按节点重要性采样（用于无树结构的情况）"""
    if len(nodes) <= target_count:
        return nodes
    
    node_scores = []
    
    for node in nodes:
        node_id = node['id']
        out_degree = sum(1 for edge in edges if edge['source'] == node_id)
        in_degree = sum(1 for edge in edges if edge['target'] == node_id)
        content_score = min(len(node.get('memory', '')), 200) / 10
        connection_score = (out_degree + in_degree) * 5
        random_score = random.random() * 10
        
        total_score = content_score + connection_score + random_score
        node_scores.append((node, total_score))
    
    node_scores.sort(key=lambda x: x[1], reverse=True)
    return [node for node, _ in node_scores[:target_count]]

# 修改主函数以使用新的采样策略
def convert_graph_to_tree_forworkmem(json_data: Dict[str, Any], 
                                 target_node_count: int = 150,
                                 type_ratios: Dict[str, float] = None) -> Dict[str, Any]:
    """
    增强版图转树函数，优先考虑分支度和类型平衡
    """
    original_nodes = json_data.get('nodes', [])
    original_edges = json_data.get('edges', [])
    
    print(f"原始节点数量: {len(original_nodes)}")
    print(f"目标节点数量: {target_node_count}")
    filter_original_edges = []
    for original_edge in original_edges:
        if original_edge["type"] == "PARENT":
            filter_original_edges.append(original_edge)
    original_edges = filter_original_edges
    # 使用增强的类型平衡采样
    if len(original_nodes) > target_node_count:
        nodes, edges = sample_nodes_with_type_balance(
            original_nodes, original_edges, target_node_count, type_ratios
        )
    else:
        nodes, edges = original_nodes, original_edges
    
    # 构建树结构的其余部分保持不变...
    # [这里是原来的树构建代码]
    
    # 创建节点映射表
    node_map = {}
    for node in nodes:
        memory = node.get('memory', '')
        node_map[node['id']] = {
            'id': node['id'],
            'value': memory,
            "frequency": random.randint(1, 100),
            'node_name': extract_node_name(memory),
            'memory_type': node.get('metadata', {}).get('memory_type', 'Unknown'),
            'children': []
        }
    
    # 构建父子关系映射
    children_map = {}
    parent_map = {}
    
    for edge in edges:
        source = edge['source']
        target = edge['target']
        if source not in children_map:
            children_map[source] = []
        children_map[source].append(target)
        parent_map[target] = source
    
    # 找到根节点
    all_node_ids = set(node_map.keys())
    children_node_ids = set(parent_map.keys())
    root_node_ids = all_node_ids - children_node_ids
    
    # 分离WorkingMemory和其他根节点
    working_memory_roots = []
    other_roots = []
    
    for root_id in root_node_ids:
        if node_map[root_id]['memory_type'] == 'WorkingMemory':
            working_memory_roots.append(root_id)
        else:
            other_roots.append(root_id)
    
    def build_tree(node_id: str) -> Dict[str, Any]:
        """递归构建树结构"""
        if node_id not in node_map:
            return None
            
        children_ids = children_map.get(node_id, [])
        children = []
        for child_id in children_ids:
            child_tree = build_tree(child_id)
            if child_tree:
                children.append(child_tree)
        
        node = {
            'id': node_id,
            'node_name': node_map[node_id]['node_name'],
            'value': node_map[node_id]['value'],
            'memory_type': node_map[node_id]['memory_type'],
            'frequency': node_map[node_id]['frequency']
        }
        
        if children:
            node['children'] = children
        
        return node
    
    # 构建根树列表
    root_trees = []
    for root_id in other_roots:
        tree = build_tree(root_id)
        if tree:
            root_trees.append(tree)
    
    # 处理WorkingMemory
    if working_memory_roots:
        working_memory_children = []
        for wm_root_id in working_memory_roots:
            tree = build_tree(wm_root_id)
            if tree:
                working_memory_children.append(tree)
        
        working_memory_node = {
            'id': 'WorkingMemory',
            'node_name': 'WorkingMemory',
            'value': 'WorkingMemory',
            'memory_type': 'WorkingMemory',
            'children': working_memory_children,
            'frequency': 0
        }
        
        root_trees.append(working_memory_node)
    
    # 创建总根节点
    result = {
        'id': 'root',
        'node_name': 'root',
        'value': 'root',
        'memory_type': 'Root',
        'children': root_trees,
        'frequency': 0
    }
    
    return result

def print_tree_structure(node: Dict[str, Any], level: int = 0, max_level: int = 5):
    """打印树结构的前几层，便于查看"""
    if level > max_level:
        return
        
    indent = "  " * level
    node_id = node.get('id', 'unknown')
    node_name = node.get('node_name', '')
    node_value = node.get('value', '')
    memory_type = node.get('memory_type', 'Unknown')
    
    # 根据是否有children判断显示方式
    children = node.get('children', [])
    if children:
        # 中间节点，显示名称、类型和子节点数量
        print(f"{indent}- {node_name} [{memory_type}] ({len(children)} children)")
        print(f"{indent}  ID: {node_id}")
        if len(node_value) > 80:
            display_value = node_value[:80] + "..."
        else:
            display_value = node_value
        print(f"{indent}  Value: {display_value}")
        
        if level < max_level:
            for child in children:
                print_tree_structure(child, level + 1, max_level)
        elif level == max_level:
            print(f"{indent}  ... (展开被限制)")
    else:
        # 叶子节点，显示名称、类型和value
        if len(node_value) > 80:
            display_value = node_value[:80] + "..."
        else:
            display_value = node_value
        print(f"{indent}- {node_name} [{memory_type}]: {display_value}")
        print(f"{indent}  ID: {node_id}")

def analyze_final_tree_quality(tree_data: Dict[str, Any]) -> Dict:
    """分析最终树的质量，包括类型多样性、分支结构等"""
    stats = {
        'total_nodes': 0,
        'by_type': {},
        'by_depth': {},
        'max_depth': 0,
        'total_leaves': 0,
        'total_branches': 0,  # 有多个子节点的分支节点数
        'subtrees': [],
        'type_diversity': {},
        'structure_quality': {},
        'chain_analysis': {}  # 单链结构分析
    }
    
    def analyze_subtree(node, depth=0, parent_path="", chain_length=0):
        stats['total_nodes'] += 1
        stats['max_depth'] = max(stats['max_depth'], depth)
        
        # 按类型统计
        memory_type = node.get('memory_type', 'Unknown')
        stats['by_type'][memory_type] = stats['by_type'].get(memory_type, 0) + 1
        
        # 按深度统计
        stats['by_depth'][depth] = stats['by_depth'].get(depth, 0) + 1
        
        children = node.get('children', [])
        current_path = f"{parent_path}/{node.get('node_name', 'unknown')}" if parent_path else node.get('node_name', 'root')
        
        # 分析节点类型
        if not children:  # 叶子节点
            stats['total_leaves'] += 1
            # 记录单链长度
            if 'max_chain_length' not in stats['chain_analysis']:
                stats['chain_analysis']['max_chain_length'] = 0
            stats['chain_analysis']['max_chain_length'] = max(
                stats['chain_analysis']['max_chain_length'], chain_length
            )
        elif len(children) == 1:  # 单子节点（链式）
            # 继续计算链长度
            for child in children:
                analyze_subtree(child, depth + 1, current_path, chain_length + 1)
            return  # 提前返回，避免重复处理
        else:  # 分支节点（多个子节点）
            stats['total_branches'] += 1
            # 重置链长度
            chain_length = 0
        
        # 如果是主要子树的根节点，分析其特征
        if depth <= 2 and children:  # 主要子树
            subtree_depth = 0
            subtree_leaves = 0
            subtree_nodes = 0
            subtree_branches = 0
            subtree_types = {}
            subtree_max_width = 0
            width_per_level = {}
            
            def count_subtree(subnode, subdepth):
                nonlocal subtree_depth, subtree_leaves, subtree_nodes, subtree_branches, subtree_max_width
                subtree_nodes += 1
                subtree_depth = max(subtree_depth, subdepth)
                
                # 统计子树内的类型分布
                sub_memory_type = subnode.get('memory_type', 'Unknown')
                subtree_types[sub_memory_type] = subtree_types.get(sub_memory_type, 0) + 1
                
                # 统计每层宽度
                width_per_level[subdepth] = width_per_level.get(subdepth, 0) + 1
                subtree_max_width = max(subtree_max_width, width_per_level[subdepth])
                
                subchildren = subnode.get('children', [])
                if not subchildren:
                    subtree_leaves += 1
                elif len(subchildren) > 1:
                    subtree_branches += 1
                
                for child in subchildren:
                    count_subtree(child, subdepth + 1)
            
            count_subtree(node, 0)
            
            # 计算子树质量指标
            branch_density = subtree_branches / subtree_nodes if subtree_nodes > 0 else 0
            leaf_ratio = subtree_leaves / subtree_nodes if subtree_nodes > 0 else 0
            depth_width_ratio = subtree_depth / subtree_max_width if subtree_max_width > 0 else subtree_depth
            
            stats['subtrees'].append({
                'root': node.get('node_name', 'unknown'),
                'type': memory_type,
                'depth': subtree_depth,
                'leaves': subtree_leaves,
                'nodes': subtree_nodes,
                'branches': subtree_branches,
                'branch_density': branch_density,
                'leaf_ratio': leaf_ratio,
                'max_width': subtree_max_width,
                'depth_width_ratio': depth_width_ratio,
                'path': current_path,
                'type_distribution': subtree_types,
                'quality_score': calculate_enhanced_quality(
                    subtree_depth, subtree_leaves, subtree_nodes, subtree_branches,
                    0, branch_density, depth_width_ratio, subtree_max_width
                )
            })
        
        # 递归分析子节点
        for child in children:
            analyze_subtree(child, depth + 1, current_path, 0)  # 重置链长度
    
    analyze_subtree(tree_data)
    
    # 计算整体结构质量
    if stats['total_nodes'] > 1:
        branch_density = stats['total_branches'] / stats['total_nodes']
        leaf_ratio = stats['total_leaves'] / stats['total_nodes']
        
        # 计算平均每层宽度
        total_width = sum(stats['by_depth'].values())
        avg_width = total_width / len(stats['by_depth']) if stats['by_depth'] else 0
        max_width = max(stats['by_depth'].values()) if stats['by_depth'] else 0
        
        stats['structure_quality'] = {
            'branch_density': branch_density,
            'leaf_ratio': leaf_ratio,
            'avg_width': avg_width,
            'max_width': max_width,
            'depth_width_ratio': stats['max_depth'] / max_width if max_width > 0 else stats['max_depth'],
            'is_well_balanced': 0.2 <= branch_density <= 0.6 and 0.3 <= leaf_ratio <= 0.7
        }
    
    # 计算类型多样性指标
    total_types = len(stats['by_type'])
    if total_types > 1:
        # 计算类型分布的均匀度 (香农多样性指数)
        shannon_diversity = 0
        for count in stats['by_type'].values():
            if count > 0:
                p = count / stats['total_nodes']
                shannon_diversity -= p * math.log2(p)
        
        # 归一化多样性指数 (0-1之间)
        max_diversity = math.log2(total_types) if total_types > 1 else 0
        normalized_diversity = shannon_diversity / max_diversity if max_diversity > 0 else 0
        
        stats['type_diversity'] = {
            'total_types': total_types,
            'shannon_diversity': shannon_diversity,
            'normalized_diversity': normalized_diversity,
            'distribution_balance': min(stats['by_type'].values()) / max(stats['by_type'].values()) if max(stats['by_type'].values()) > 0 else 0
        }
    
    # 单链分析
    total_single_child_nodes = sum(1 for subtree in stats['subtrees'] 
                                  if subtree.get('branch_density', 0) < 0.1)
    stats['chain_analysis'].update({
        'single_chain_subtrees': total_single_child_nodes,
        'chain_subtree_ratio': total_single_child_nodes / len(stats['subtrees']) if stats['subtrees'] else 0
    })
    
    return stats

def print_tree_analysis(tree_data: Dict[str, Any]):
    """打印增强的树分析结果"""
    stats = analyze_final_tree_quality(tree_data)
    
    print("\n" + "="*60)
    print("🌳 增强树结构质量分析报告")
    print("="*60)
    
    # 基础统计
    print(f"\n📊 基础统计:")
    print(f"  总节点数: {stats['total_nodes']}")
    print(f"  最大深度: {stats['max_depth']}")
    print(f"  叶子节点数: {stats['total_leaves']} ({stats['total_leaves']/stats['total_nodes']*100:.1f}%)")
    print(f"  分支节点数: {stats['total_branches']} ({stats['total_branches']/stats['total_nodes']*100:.1f}%)")
    
    # 结构质量评估
    structure = stats.get('structure_quality', {})
    if structure:
        print(f"\n🏗️  结构质量评估:")
        print(f"  分支密度: {structure['branch_density']:.3f} ({'✅ 良好' if 0.2 <= structure['branch_density'] <= 0.6 else '⚠️  需改进'})")
        print(f"  叶子比例: {structure['leaf_ratio']:.3f} ({'✅ 良好' if 0.3 <= structure['leaf_ratio'] <= 0.7 else '⚠️  需改进'})")
        print(f"  最大宽度: {structure['max_width']}")
        print(f"  深度宽度比: {structure['depth_width_ratio']:.2f} ({'✅ 良好' if structure['depth_width_ratio'] <= 3 else '⚠️  过细长'})")
        print(f"  整体平衡性: {'✅ 良好' if structure['is_well_balanced'] else '⚠️  需改进'}")
    
    # 单链分析
    chain_analysis = stats.get('chain_analysis', {})
    if chain_analysis:
        print(f"\n🔗 单链结构分析:")
        print(f"  最长单链: {chain_analysis.get('max_chain_length', 0)} 层")
        print(f"  单链子树数: {chain_analysis.get('single_chain_subtrees', 0)}")
        print(f"  单链子树比例: {chain_analysis.get('chain_subtree_ratio', 0)*100:.1f}%")
        
        if chain_analysis.get('max_chain_length', 0) > 5:
            print("  ⚠️  警告: 存在过长的单链结构，可能影响展示效果")
        elif chain_analysis.get('chain_subtree_ratio', 0) > 0.3:
            print("  ⚠️  警告: 单链子树过多，建议增加分支结构")
        else:
            print("  ✅ 单链结构控制良好")
    
    # 类型多样性
    type_div = stats.get('type_diversity', {})
    if type_div:
        print(f"\n🎨 类型多样性分析:")
        print(f"  类型总数: {type_div['total_types']}")
        print(f"  多样性指数: {type_div['shannon_diversity']:.3f}")
        print(f"  归一化多样性: {type_div['normalized_diversity']:.3f}")
        print(f"  分布平衡度: {type_div['distribution_balance']:.3f}")
    
    # 类型分布
    print(f"\n📋 类型分布详情:")
    for mem_type, count in sorted(stats['by_type'].items(), key=lambda x: x[1], reverse=True):
        percentage = count / stats['total_nodes'] * 100
        print(f"  {mem_type}: {count} 个节点 ({percentage:.1f}%)")
    
    # 深度分布
    print(f"\n📏 深度分布:")
    for depth in sorted(stats['by_depth'].keys()):
        count = stats['by_depth'][depth]
        print(f"  深度 {depth}: {count} 个节点")
    
    # 主要子树分析
    if stats['subtrees']:
        print(f"\n🌲 主要子树分析 (按质量排序):")
        sorted_subtrees = sorted(stats['subtrees'], key=lambda x: x.get('quality_score', 0), reverse=True)
        for i, subtree in enumerate(sorted_subtrees[:8]):  # 显示前8个
            quality = subtree.get('quality_score', 0)
            print(f"  #{i+1} {subtree['root']} [{subtree['type']}]:")
            print(f"    质量分数: {quality:.2f}")
            print(f"    结构: 深度={subtree['depth']}, 分支={subtree['branches']}, 叶子={subtree['leaves']}")
            print(f"    密度: 分支密度={subtree.get('branch_density', 0):.3f}, 叶子比例={subtree.get('leaf_ratio', 0):.3f}")
            
            if quality > 15:
                print(f"    ✅ 高质量子树")
            elif quality > 8:
                print(f"    🟡 中等质量子树")
            else:
                print(f"    🔴 低质量子树")
    
    print("\n" + "="*60)


def remove_embedding_recursive(memory_info: dict) -> Any:
    """remove the embedding from the memory info
    Args:
        memory_info: product memory info
    
    Returns:
        Any: product memory info without embedding
    """
    if isinstance(memory_info, dict):
        new_dict = {}
        for key, value in memory_info.items():
            if key != "embedding":
                new_dict[key] = remove_embedding_recursive(value)
        return new_dict
    elif isinstance(memory_info, list):
        return [remove_embedding_recursive(item) for item in memory_info]
    else:
        return memory_info
    
def remove_embedding_from_memory_items(memory_items: list[Any]) -> list[dict]:
    """批量移除多个 TextualMemoryItem 中的 embedding 字段"""
    clean_memories = []
    
    for item in memory_items:
        memory_dict = item.model_dump()
        
        # 移除 metadata 中的 embedding
        if "metadata" in memory_dict and "embedding" in memory_dict["metadata"]:
            del memory_dict["metadata"]["embedding"]
        
        clean_memories.append(memory_dict)
    
    return clean_memories
    
def sort_children_by_memory_type(children: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    sort the children by the memory_type
    Args:
        children: the children of the node
    Returns:
        the sorted children
    """
    if not children:
        return children
    
    def get_sort_key(child):
        memory_type = child.get('memory_type', 'Unknown')
        # 直接按memory_type字符串排序，相同类型自然会聚集在一起
        return memory_type
    
    # 按memory_type排序
    sorted_children = sorted(children, key=get_sort_key)
    
    return sorted_children


def extract_all_ids_from_tree(tree_node):
    """
    递归遍历树状结构，提取所有节点的ID
    
    Args:
        tree_node: 树的节点（字典格式）
        
    Returns:
        set: 包含所有节点ID的集合
    """
    ids = set()
    
    # 添加当前节点的ID（如果存在）
    if 'id' in tree_node:
        ids.add(tree_node['id'])
    
    # 递归处理子节点
    if 'children' in tree_node and tree_node['children']:
        for child in tree_node['children']:
            ids.update(extract_all_ids_from_tree(child))
    
    return ids

def filter_nodes_by_tree_ids(tree_data, nodes_data):
    """
    根据树状结构中使用的ID筛选nodes列表
    
    Args:
        tree_data: 树状结构数据（字典）
        nodes_data: 包含nodes列表的数据（字典）
        
    Returns:
        dict: 筛选后的nodes数据，保持原有结构
    """
    # 提取树中所有使用的ID
    used_ids = extract_all_ids_from_tree(tree_data)
    
    # 筛选nodes列表，只保留ID在树中使用的节点
    filtered_nodes = [
        node for node in nodes_data['nodes'] 
        if node['id'] in used_ids
    ]
    
    # 返回保持原有结构的结果
    return {
        'nodes': filtered_nodes
    }


def convert_activation_memory_to_serializable(act_mem_items: List[KVCacheItem]) -> List[Dict[str, Any]]:
    """
    Convert activation memory items to a serializable format.
    
    Args:
        act_mem_items: List of KVCacheItem objects
        
    Returns:
        List of dictionaries with serializable data
    """
    serializable_items = []
    
    for item in act_mem_items:
        # Extract basic information that can be serialized
        serializable_item = {
            "id": item.id,
            "metadata": item.metadata,
            "memory_info": {
                "type": "DynamicCache",
                "key_cache_layers": len(item.memory.key_cache) if item.memory else 0,
                "value_cache_layers": len(item.memory.value_cache) if item.memory else 0,
                "device": str(item.memory.key_cache[0].device) if item.memory and item.memory.key_cache else "unknown",
                "dtype": str(item.memory.key_cache[0].dtype) if item.memory and item.memory.key_cache else "unknown",
            }
        }
        
        # Add tensor shape information if available
        if item.memory and item.memory.key_cache:
            key_shapes = []
            value_shapes = []
            
            for i, key_tensor in enumerate(item.memory.key_cache):
                if key_tensor is not None:
                    key_shapes.append({
                        "layer": i,
                        "shape": list(key_tensor.shape)
                    })
                
                if i < len(item.memory.value_cache) and item.memory.value_cache[i] is not None:
                    value_shapes.append({
                        "layer": i,
                        "shape": list(item.memory.value_cache[i].shape)
                    })
            
            serializable_item["memory_info"]["key_shapes"] = key_shapes
            serializable_item["memory_info"]["value_shapes"] = value_shapes
        
        serializable_items.append(serializable_item)
    
    return serializable_items


def convert_activation_memory_summary(act_mem_items: List[KVCacheItem]) -> Dict[str, Any]:
    """
    Create a summary of activation memory for API responses.
    
    Args:
        act_mem_items: List of KVCacheItem objects
        
    Returns:
        Dictionary with summary information
    """
    if not act_mem_items:
        return {
            "total_items": 0,
            "summary": "No activation memory items found"
        }
    
    total_items = len(act_mem_items)
    total_layers = 0
    total_parameters = 0
    
    for item in act_mem_items:
        if item.memory and item.memory.key_cache:
            total_layers += len(item.memory.key_cache)
            
            # Calculate approximate parameter count
            for key_tensor in item.memory.key_cache:
                if key_tensor is not None:
                    total_parameters += key_tensor.numel()
            
            for value_tensor in item.memory.value_cache:
                if value_tensor is not None:
                    total_parameters += value_tensor.numel()
    
    return {
        "total_items": total_items,
        "total_layers": total_layers,
        "total_parameters": total_parameters,
        "summary": f"Activation memory contains {total_items} items with {total_layers} layers and approximately {total_parameters:,} parameters"
    }