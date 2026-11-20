---
title: Error Codes
---

| Error Code | Meaning | Recommended Action |
| :--- | :--- | :--- |
| **Parameter Errors** | | |
| 40000 | Invalid request parameters | Check whether parameter names, types, and formats meet the requirements. |
| 40001 | Requested data does not exist | Check whether the resource ID, such as `memory_id`, is correct. |
| 40002 | Required parameter is empty | Add the missing required field. |
| 40003 | Parameter is empty | Check whether the provided list or object is empty. |
| 40006 | Unsupported type | Check the value of the `type` field. |
| 40007 | Unsupported file type | Upload only allowed formats: `.pdf`, `.docx`, `.doc`, `.txt`. |
| 40008 | Invalid Base64 content | Check whether the Base64 string contains invalid characters. |
| 40009 | Invalid Base64 format | Check whether the Base64 encoding format is correct. |
| 40010 | User ID is too long | `user_id` must not exceed 100 characters. |
| 40011 | Conversation ID is too long | `conversation_id` must not exceed 100 characters. |
| 40020 | Invalid project ID | Confirm that the Project ID format is correct. |
| **Authentication and Permission Errors** | | |
| 40100 | API Key authentication required | Add a valid API Key to the request header. |
| 40130 | API Key authentication required | Add a valid API Key to the request header. |
| 40132 | API Key is invalid or expired | Check the API Key status or regenerate it. |
| **Quota and Rate Limit Errors** | | |
| 40300 | API call limit exceeded | <a href="/memos_cloud/limit#_4-领取更多额度" target="_blank">Get more quota</a>. |
| 40301 | Request token call limit exceeded | Reduce input content or get more quota. |
| 40302 | Response token call limit exceeded | Shorten the expected output or get more quota. |
| 40303 | Single conversation length exceeds the limit | Reduce the length of a single input or output. |
| 40304 | Account API call quota exhausted | <a href="/memos_cloud/limit#_4-领取更多额度" target="_blank">Get more quota</a>. |
| 40305 | Input exceeds the single-request token limit | Reduce input content. |
| 40306 | Delete memory authorization failed | Confirm that you have permission to delete the memory. |
| 40307 | Memory to delete does not exist | Check whether `memory_id` is valid. |
| 40308 | User for the memory to delete does not exist | Check whether `user_id` is correct. |
| **System and Service Errors** | | |
| 50000 | Internal system exception | The server is busy or encountered an exception. Contact support if it persists. |
| 50002 | Operation failed | Check the operation logic or retry later. |
| 50004 | Memory service temporarily unavailable | Retry memory write or retrieval later. |
| 50005 | Search service temporarily unavailable | Retry memory search later. |
| **Knowledge Base and Operation Errors** | | |
| 50103 | File count exceeds the limit | Upload no more than 20 files in one request. |
| 50104 | Single file size exceeds the limit | Ensure each file is no larger than 100 MB. |
| 50105 | Total file size exceeds the limit | Ensure the total upload size is no larger than 300 MB. |
| 50107 | File upload format does not meet requirements | Check and replace the file format. |
| 50120 | Knowledge base does not exist | Confirm that the knowledge base ID is correct. |
| 50123 | Knowledge base is not associated with this project | Confirm that the knowledge base is authorized for the current project. |
| 50131 | Task does not exist | Check whether `task_id` is correct. This is common when querying processing status. |
| 50143 | Failed to add memory | The algorithm service encountered an exception. Retry later. |
| 50144 | Failed to add message | Failed to save chat history. |
| 50145 | Failed to save feedback and write memory | An exception occurred while processing feedback. |
