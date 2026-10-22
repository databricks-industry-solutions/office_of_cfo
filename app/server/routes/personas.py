"""Persona hierarchy + org tree for the demo 'view as' control (Item 5)."""
from fastapi import APIRouter

from ..personas import org_tree, personas

router = APIRouter()


@router.get("/personas")
def list_personas():
    return {"personas": personas()}


@router.get("/org-tree")
def get_org_tree():
    return org_tree()
