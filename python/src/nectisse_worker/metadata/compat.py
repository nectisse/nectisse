"""Wiki 纯解析所需的小契约，不导入 Peach 数据库、脚本入口或网络层。"""
from peach_core.catalog_rules import normalise_code_key
from .base import FailureReason, SourceFailure


class MetadataProviderError(SourceFailure):
    def __init__(self, message, *, kind='parse_error', **kwargs):
        reason = FailureReason.BUDGET if kind in {'budget', 'incomplete_search'} else FailureReason.AUTH_REQUIRED if kind == 'auth' else FailureReason.PARSE_ERROR
        super().__init__(reason, message)


def validate_provider_code(code):
    value = normalise_code_key(str(code))
    if not value:
        raise SourceFailure(FailureReason.UNSUPPORTED, '需要完整作品编号')
    return value


def auth_error(label, message, **kwargs):
    return SourceFailure(FailureReason.AUTH_REQUIRED, f'{label}：{message}')


def auth_wall_reason(value):
    return ''
