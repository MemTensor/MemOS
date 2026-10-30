"""Exercise implemented provider methods while production remains abstract.

Only tests use this class. Every unfinished operation raises, so a test cannot
mistake an unimplemented capability for a successful empty result.
"""

from memos.graph_dbs.opengauss import OpenGaussGraphDB


class PartialOpenGaussGraphDB(OpenGaussGraphDB):
    def _unimplemented(self, *args, **kwargs):
        raise NotImplementedError("This openGauss capability is not implemented yet")

    get_context_chain = _unimplemented
    search_by_embedding = _unimplemented
    get_structure_optimization_candidates = _unimplemented
    deduplicate_nodes = _unimplemented
    detect_conflicts = _unimplemented
    merge_nodes = _unimplemented
    clear = _unimplemented
    export_graph = _unimplemented
    import_graph = _unimplemented
